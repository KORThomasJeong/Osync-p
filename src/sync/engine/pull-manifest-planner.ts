import type { SyncedEntryMetadata } from "../core/content";
import {
  type ConflictFileWriter,
  getAvailableConflictCopyPath,
} from "../core/conflict-file";
import type { SyncCryptoService } from "../core/crypto-service";
import { queueLocalDeleteMutation } from "../core/mutation-queue";
import type { RemoteEntryState } from "../remote/changes";
import type {
  SyncEntryRow,
} from "../store/store";
import type {
  SyncEntryStore,
  SyncMutationStore,
} from "../store/ports";
import { toPathKey } from "../store/dexie/path-key";
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
    const dedupLosers = this.findIdenticalContentDedupLosers(
      manifest,
      deferredCursorThreshold,
    );
    // reservedPaths is keyed by NFC path key so two remote entries that differ only by
    // Unicode normalization form (NFD vs NFC) are treated as the same logical path.
    const reservedPaths = new Map<string, string>();
    const plans: PlannedEntryState[] = [];
    const deferred: PullEntryStateManifestItem[] = [];

    for (const item of manifest) {
      const { state, metadata } = item;
      if (isDeferredByCursorThreshold(item, deferredCursorThreshold)) {
        deferred.push(item);
        continue;
      }

      if (dedupLosers.has(state.entryId)) {
        // Identical-content duplicate of another remote entry on the same NFC path
        // key. The winner keeps the real path; this loser is removed server-side via
        // a delete mutation instead of producing a .sync-conflict copy.
        await queueLocalDeleteMutation(store, {
          crypto: this.deps.crypto,
          entryId: state.entryId,
          base: {
            revision: state.revision,
            deleted: state.deleted,
            blobId: state.blobId,
            hash: metadata.hash,
          },
          path: metadata.path,
          editedAt: metadata.editedAt ?? state.updatedAt,
        });
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

          const duplicateEntryId = reservedPaths.get(toPathKey(metadata.path));
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
          reservedPaths.set(toPathKey(finalPath), state.entryId);
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

  /**
   * Detects sets of remote entries that resolve to the same NFC path key AND carry
   * identical content hashes (e.g. one entry stored as NFD, a duplicate stored as NFC).
   * Such pairs are pure duplicates rather than genuine path conflicts: keeping both would
   * spawn a redundant .sync-conflict copy. For each identical-content set we pick a
   * deterministic winner (highest revision -> newest updatedAt -> smallest entryId) to keep
   * at the real path and return the remaining entryIds as "losers" to be deleted server-side.
   *
   * Entries that collide on the NFC path key but differ in content are left untouched here so
   * the existing conflict-copy path continues to preserve their data.
   */
  private findIdenticalContentDedupLosers(
    manifest: PullEntryStateManifestItem[],
    deferredCursorThreshold: number | null,
  ): Set<string> {
    const byPathKey = new Map<string, PullEntryStateManifestItem[]>();
    for (const item of manifest) {
      const { state, metadata } = item;
      if (
        isDeferredByCursorThreshold(item, deferredCursorThreshold) ||
        state.deleted ||
        state.entryType === "folder" ||
        !metadata.hash
      ) {
        continue;
      }
      const pathKey = toPathKey(metadata.path);
      const group = byPathKey.get(pathKey);
      if (group) {
        group.push(item);
      } else {
        byPathKey.set(pathKey, [item]);
      }
    }

    const losers = new Set<string>();
    for (const group of byPathKey.values()) {
      if (group.length < 2) {
        continue;
      }
      const byHash = new Map<string, PullEntryStateManifestItem[]>();
      for (const item of group) {
        const hash = item.metadata.hash!;
        const sameHash = byHash.get(hash);
        if (sameHash) {
          sameHash.push(item);
        } else {
          byHash.set(hash, [item]);
        }
      }
      for (const sameHash of byHash.values()) {
        if (sameHash.length < 2) {
          continue;
        }
        const winner = sameHash.reduce((best, candidate) =>
          this.isDeterministicDedupWinner(candidate.state, best.state) ? candidate : best,
        );
        for (const item of sameHash) {
          if (item.state.entryId !== winner.state.entryId) {
            losers.add(item.state.entryId);
          }
        }
      }
    }
    return losers;
  }

  private isDeterministicDedupWinner(
    candidate: RemoteEntryState,
    incumbent: RemoteEntryState,
  ): boolean {
    if (candidate.revision !== incumbent.revision) {
      return candidate.revision > incumbent.revision;
    }
    if (candidate.updatedAt !== incumbent.updatedAt) {
      return candidate.updatedAt > incumbent.updatedAt;
    }
    return candidate.entryId < incumbent.entryId;
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
    while (reservedPaths.has(toPathKey(conflictPath))) {
      conflictPath = await getAvailableConflictCopyPath(
        {
          exists: async (candidate) =>
            reservedPaths.has(toPathKey(candidate)) ||
            (await this.deps.vaultAdapter.exists(candidate)),
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
    Pick<SyncMutationStore, "getDirtyEntryMutation" | "replaceDirtyEntry"> {}
