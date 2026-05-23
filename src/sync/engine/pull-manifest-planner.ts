import type { SyncedEntryMetadata } from "../core/content";
import {
  type ConflictFileWriter,
  getAvailableConflictCopyPath,
} from "../core/conflict-file";
import type { SyncCryptoService } from "../core/crypto-service";
import type { RemoteEntryState } from "../remote/changes";
import type {
  SyncEntryRow,
} from "../store/store";
import type {
  SyncEntryStore,
  SyncMutationStore,
} from "../store/ports";
import { decideConflictWinner } from "./conflict-tiebreak";
import {
  type AdoptedLocalEntry,
  isDeferredByCursorThreshold,
  metadataContextFromPendingMutation,
  type PlannedEntryState,
  type PullConflictEvent,
  type PullEntryStateManifestItem,
} from "./pull-entry-state-internal";

interface PullManifestPlannerDeps {
  crypto: SyncCryptoService;
  vaultAdapter: ConflictFileWriter;
  onConflict?: (event: PullConflictEvent) => void;
  now?: () => number;
}

export class PullManifestPlanner {
  constructor(private readonly deps: PullManifestPlannerDeps) {}

  async planManifest(
    store: PullManifestStore,
    manifest: PullEntryStateManifestItem[],
    options: { deferExternalPathOwners: boolean },
  ): Promise<{
    plans: PlannedEntryState[];
    deferred: PullEntryStateManifestItem[];
  }> {
    const deferredEntryIds = new Set<string>();
    if (options.deferExternalPathOwners) {
      let changed = true;
      while (changed) {
        changed = false;
        const activeEntryIds = new Set(
          manifest
            .map((item) => item.state.entryId)
            .filter((entryId) => !deferredEntryIds.has(entryId)),
        );

        for (const { state, metadata } of manifest) {
          if (deferredEntryIds.has(state.entryId) || state.deleted) {
            continue;
          }
          if (state.entryType === "folder") {
            continue;
          }
          if (!state.blobId) {
            throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
          }
          if (!metadata.hash) {
            throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a hash.`);
          }

          const pathOwner = await store.getEntryByPath(metadata.path);
          const adoptedLocalEntry = pathOwner
            ? await this.findAdoptableLocalPathOwner(store, state, metadata, pathOwner, metadata.hash)
            : null;
          const externalPathOwner =
            pathOwner &&
            pathOwner.entryId !== state.entryId &&
            !activeEntryIds.has(pathOwner.entryId) &&
            !adoptedLocalEntry;
          if (externalPathOwner) {
            deferredEntryIds.add(state.entryId);
            changed = true;
          }
        }
      }
    }

    const deferredCursorThreshold =
      deferredEntryIds.size > 0
        ? Math.min(
            ...manifest
              .filter((item) => deferredEntryIds.has(item.state.entryId))
              .map((item) => item.state.updatedSeq),
          )
        : null;
    const deltaEntryIds = new Set(
      manifest
        .filter((item) => !isDeferredByCursorThreshold(item, deferredCursorThreshold))
        .map((item) => item.state.entryId),
    );
    const reservedPaths = new Map<string, string>();
    const plans: PlannedEntryState[] = [];
    const deferred: PullEntryStateManifestItem[] = [];

    for (const item of manifest) {
      const { state, metadata } = item;
      if (isDeferredByCursorThreshold(item, deferredCursorThreshold)) {
        deferred.push(item);
        continue;
      }

      const existing = await store.getEntryById(state.entryId);
      let finalPath: string | null = null;
      let hash: string | null = null;
      let pathConflict: PullConflictEvent | null = null;
      let adoptedLocalEntry: AdoptedLocalEntry | null = null;

      if (!state.deleted) {
        if (state.entryType === "folder") {
          finalPath = metadata.path;
          hash = null;
        } else {
          if (!state.blobId) {
            throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
          }
          if (!metadata.hash) {
            throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a hash.`);
          }
          hash = metadata.hash;

          const duplicateEntryId = reservedPaths.get(metadata.path);
          const pathOwner = await store.getEntryByPath(metadata.path);
          adoptedLocalEntry = pathOwner
            ? await this.findAdoptableLocalPathOwner(store, state, metadata, pathOwner, hash)
            : null;
          const externalPathOwner =
            pathOwner &&
            pathOwner.entryId !== state.entryId &&
            !deltaEntryIds.has(pathOwner.entryId) &&
            !adoptedLocalEntry;
          if (externalPathOwner && options.deferExternalPathOwners) {
            deferred.push(item);
            continue;
          }
          if (duplicateEntryId || externalPathOwner) {
            const localOwnerPending = pathOwner
              ? await store.getDirtyEntryMutation(pathOwner.entryId)
              : null;
            const localPendingMeta = localOwnerPending
              ? await this.deps.crypto.decryptMetadata(
                  localOwnerPending.encryptedMetadata,
                  metadataContextFromPendingMutation(localOwnerPending),
                )
              : null;
            pathConflict = await this.createPathCollisionEvent(
              state.entryId,
              metadata.path,
              reservedPaths,
              {
                serverEditedAt: metadata.editedAt,
                serverUpdatedAt: state.updatedAt,
                serverRevision: state.revision,
                clientEditedAt: localPendingMeta?.editedAt,
                clientRevision: pathOwner?.revision ?? 0,
              },
            );
            finalPath = pathConflict.conflictPath;
          } else {
            finalPath = metadata.path;
          }

          if (!finalPath) {
            throw new Error(`Entry state ${state.entryId}@${state.revision} has no target path.`);
          }
          reservedPaths.set(finalPath, state.entryId);
        }
      } else if (state.entryType !== "folder" && metadata.hash !== null) {
        throw new Error(`Deleted entry state ${state.entryId}@${state.revision} has a hash.`);
      }

      plans.push({
        state,
        existing,
        adoptedLocalEntry,
        metadata,
        finalPath,
        hash,
        pathConflict,
        pendingConflict: null,
      });
    }

    return { plans, deferred };
  }

  private async findAdoptableLocalPathOwner(
    store: PullManifestStore,
    state: RemoteEntryState,
    metadata: SyncedEntryMetadata,
    pathOwner: SyncEntryRow,
    remoteHash: string,
  ): Promise<AdoptedLocalEntry | null> {
    if (
      pathOwner.entryId === state.entryId ||
      pathOwner.revision !== 0 ||
      pathOwner.deleted ||
      pathOwner.path !== metadata.path
    ) {
      return null;
    }

    const pending = await store.getDirtyEntryMutation(pathOwner.entryId);
    if (!pending || pending.op !== "upsert") {
      return null;
    }

    const pendingMetadata = await this.deps.crypto.decryptMetadata(
      pending.encryptedMetadata,
      metadataContextFromPendingMutation(pending),
    );
    if (pendingMetadata.path !== metadata.path || !pendingMetadata.hash) {
      return null;
    }

    return {
      entry: pathOwner,
      pending,
      hashMatches: pendingMetadata.hash === remoteHash && pathOwner.hash === remoteHash,
    };
  }

  private async createPathCollisionEvent(
    entryId: string,
    path: string,
    reservedPaths: ReadonlyMap<string, string>,
    tiebreak: {
      serverEditedAt: number | undefined;
      serverUpdatedAt: number | undefined;
      serverRevision: number;
      clientEditedAt: number | undefined;
      clientRevision: number;
    },
  ): Promise<PullConflictEvent> {
    let conflictPath = await getAvailableConflictCopyPath(
      this.deps.vaultAdapter,
      path,
      this.deps.now,
    );
    while (reservedPaths.has(conflictPath)) {
      conflictPath = await getAvailableConflictCopyPath(
        {
          exists: async (candidate) =>
            reservedPaths.has(candidate) || (await this.deps.vaultAdapter.exists(candidate)),
        },
        path,
        this.deps.now,
      );
    }

    const winner = decideConflictWinner(tiebreak);
    const event: PullConflictEvent = {
      entryId,
      op: "upsert",
      reason:
        winner === "client"
          ? "remote_path_collision_client_wins"
          : "remote_path_collision",
      originalPath: path,
      conflictPath,
    };
    this.deps.onConflict?.(event);
    return event;
  }
}

export interface PullManifestStore
  extends Pick<SyncEntryStore, "getEntryById" | "getEntryByPath">,
    Pick<SyncMutationStore, "getDirtyEntryMutation"> {}
