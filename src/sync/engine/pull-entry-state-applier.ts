import type { ConflictFileWriter } from "../core/conflict-file";
import { mapWithConcurrency } from "../core/concurrency";
import type { SyncCryptoService } from "../core/crypto-service";
import type { SyncTokenResponse } from "../remote/client";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncPullClient } from "../remote/pull-client";
import type { PendingMutationRow, SyncProgressCounts } from "../store/store";
import type {
  BulkEntryApplyOp,
  SyncBlobStore,
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
} from "../store/ports";
import {
  ensureParentDirectoriesBatch,
  isMarkdownPath,
  removeVaultPathIfExists,
  type SyncVaultWriter,
} from "../vault/vault-writer";
import {
  describePathLimit,
  isPathWithinSyncLimits,
} from "../core/path-limits";
import type { SyncEventGateLike } from "./event-gate";
import { PullBlobPreparer } from "./pull-blob-preparer";
import { PullManifestPlanner, type PullManifestStore } from "./pull-manifest-planner";
import { PullPendingMutationHandler } from "./pull-pending-mutation-handler";
import {
  createPathDependencyBatches,
  DEFAULT_PREPARE_CONCURRENCY,
  groupPendingConflictsByPlan,
  metadataContextFromRemoteState,
  packPathDependencyBatches,
  pathsToRemoveForPlan,
  type PullConflictEvent,
  type PullEntryStateManifestItem,
  type PlannedEntryState,
  type PreparedEntryBlob,
  type PreparedManifestApplication,
  type PreparedPendingConflict,
  type PreparedPathBatch,
  type SnapshotEntryState,
  uniquePendingConflicts,
  uniqueSyncPaths,
} from "./pull-entry-state-internal";

const FILE_WRITE_CONCURRENCY = 25;

export interface PullEntryStateApplierDeps {
  getApiBaseUrl: () => string;
  crypto: SyncCryptoService;
  vaultAdapter: PullEntryStateVaultAdapter;
  eventGate?: SyncEventGateLike;
  pullClient: Pick<SyncPullClient, "downloadBlob">;
  prepareConcurrency?: number;
  onProgress?: (progress: SyncProgressCounts) => Promise<void>;
  onConflict?: (event: PullConflictEvent) => void;
  now?: () => number;
}

export interface PullEntryStateApplyResult {
  entriesApplied: number;
  filesWritten: number;
  filesDeleted: number;
  conflictsCreated: number;
}

export type { PullConflictEvent, PullEntryStateManifestItem };

export interface PullEntryStateVaultAdapter
  extends ConflictFileWriter,
    SyncVaultWriter {
  readBytes(path: string): Promise<Uint8Array>;
  isFolderEmpty(path: string): Promise<boolean>;
}

export interface PullEntryStateStore
  extends PullManifestStore,
    Pick<
      SyncEntryStore,
      "deleteEntry" | "getEntryStateById" | "upsertEntry"
    >,
    Pick<
      SyncRemoteEntryStore,
      "applyRemoteState" | "clearRemoteState" | "getRemoteStateById"
    >,
    Pick<
      SyncLocalEntryStore,
      "applyLocalState" | "bulkApply" | "clearLocalState" | "getLocalStateById"
    >,
    Pick<
      SyncMutationStore,
      | "clearDirtyEntryByMutationId"
      | "listDirtyEntries"
      | "markEntryDirty"
      | "replaceDirtyEntry"
    >,
    Pick<SyncBlobStore, "getBlob" | "putBlob"> {}

export type PullEntryStateWindowApplyResult = PullEntryStateApplyResult & {
  deferred: PullEntryStateManifestItem[];
};

export class PullEntryStateApplier {
  private readonly blobPreparer: PullBlobPreparer;
  private readonly manifestPlanner: PullManifestPlanner;
  private readonly pendingMutations: PullPendingMutationHandler;

  constructor(private readonly deps: PullEntryStateApplierDeps) {
    this.blobPreparer = new PullBlobPreparer(deps);
    this.manifestPlanner = new PullManifestPlanner(deps);
    this.pendingMutations = new PullPendingMutationHandler(deps);
  }

  async createManifestItems(
    states: RemoteEntryState[],
  ): Promise<PullEntryStateManifestItem[]> {
    return await mapWithConcurrency(
      states,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (state) => {
        try {
          return {
            state,
            metadata: await this.deps.crypto.decryptMetadata(
              state.encryptedMetadata,
              metadataContextFromRemoteState(state),
            ),
          };
        } catch (error) {
          const ctx = metadataContextFromRemoteState(state);
          console.error(
            `[osync] pull: failed to decrypt remote entry ${ctx.entryId} rev=${ctx.revision} op=${ctx.op} blobId=${ctx.blobId ?? "null"}`,
            error,
          );
          throw error;
        }
      },
    );
  }

  async applyEntryStates(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    states: RemoteEntryState[],
  ): Promise<PullEntryStateApplyResult> {
    return await this.applyManifest(
      store,
      token,
      await this.createManifestItems(states),
    );
  }

  async applyManifest(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    manifest: PullEntryStateManifestItem[],
  ): Promise<PullEntryStateApplyResult> {
    const applied = await this.applyManifestWindow(store, token, manifest, {
      finalWindow: true,
    });
    return {
      entriesApplied: applied.entriesApplied,
      filesWritten: applied.filesWritten,
      filesDeleted: applied.filesDeleted,
      conflictsCreated: applied.conflictsCreated,
    };
  }

  async applyManifestWindow(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    manifest: PullEntryStateManifestItem[],
    options: {
      finalWindow: boolean;
      skipDeletions?: boolean;
      progress?: {
        completedOffset: number;
        totalEntries: number;
      };
    },
  ): Promise<PullEntryStateWindowApplyResult> {
    if (manifest.length === 0) {
      return {
        entriesApplied: 0,
        filesWritten: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        deferred: [],
      };
    }

    const prepared = await this.prepareManifestApplication(store, token, manifest, {
      deferExternalPathOwners: !options.finalWindow,
    });
    const filesDeleted = await this.applyPreparedManifest(
      store,
      prepared,
      options.progress,
      options.skipDeletions ?? false,
    );

    return {
      entriesApplied: prepared.plans.length,
      filesWritten: prepared.pathsToWrite.length,
      filesDeleted,
      conflictsCreated: prepared.plans.reduce(
        (count, plan) =>
          count +
          (plan.pathConflict?.conflictPath ? 1 : 0) +
          (plan.pendingConflict?.conflictPath ? 1 : 0),
        0,
      ),
      deferred: prepared.deferred,
    };
  }

  private async prepareManifestApplication(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    manifest: PullEntryStateManifestItem[],
    options: { deferExternalPathOwners: boolean },
  ): Promise<PreparedManifestApplication> {
    const { plans, deferred } = await this.manifestPlanner.planManifest(
      store,
      manifest,
      options,
    );
    const pathsToWrite = uniqueSyncPaths(plans.map((plan) => plan.finalPath));
    const pendingConflicts: PreparedPendingConflict[] = [];
    const preparedPendingMutationIds = new Set<string>();
    const batches: PreparedPathBatch[] = [];
    const preparedBlobs = await this.blobPreparer.preparePathBatchBlobs(
      store,
      token,
      plans,
    );
    const blobByPlan = new Map(preparedBlobs.map((blob) => [blob.plan, blob]));

    for (const plan of plans) {
      if (plan.adoptedLocalEntry?.hashMatches) {
        continue;
      }

      const pendingConflict = await this.pendingMutations.prepareConflictingPendingMutation(
        store,
        plan,
        blobByPlan.get(plan) ?? null,
      );
      if (pendingConflict) {
        if (preparedPendingMutationIds.has(pendingConflict.pending.mutationId)) {
          continue;
        }
        preparedPendingMutationIds.add(pendingConflict.pending.mutationId);
        plan.pendingConflict = pendingConflict.event;
        pendingConflicts.push(pendingConflict);
      }
    }

    const pathBatches = packPathDependencyBatches(
      createPathDependencyBatches(plans),
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
    );

    for (const batchPlans of pathBatches) {
      const pathsToRemove = uniqueSyncPaths(batchPlans.flatMap(pathsToRemoveForPlan));
      const blobs = batchPlans
        .map((plan) => blobByPlan.get(plan))
        .filter((blob): blob is PreparedEntryBlob => !!blob);

      batches.push({ plans: batchPlans, pathsToRemove, blobs });
    }

    return {
      plans,
      pathsToWrite,
      pendingConflicts,
      batches,
      deferred,
    };
  }

  private async applyPreparedManifest(
    store: PullEntryStateStore,
    prepared: PreparedManifestApplication,
    progress:
      | {
          completedOffset: number;
          totalEntries: number;
        }
      | undefined,
    skipDeletions = false,
  ): Promise<number> {
    const originalEntries = await this.snapshotManifestEntries(store, prepared.plans);
    const originalDirtyEntries = await this.snapshotDirtyEntries(store, prepared);
    const pendingConflictsByPlan = groupPendingConflictsByPlan(prepared.pendingConflicts);

    try {
      let filesDeleted = 0;
      let entriesApplied = 0;
      const folderPaths = collectFolderPathsForSuppression(prepared.plans);
      filesDeleted = await this.runWithSuppressedPaths(
        [
          ...prepared.batches.flatMap((batch) => batch.pathsToRemove),
          ...prepared.pathsToWrite,
          ...folderPaths,
        ],
        async () => {
          let removedTotal = 0;
          for (const batch of prepared.batches) {
            const batchPendingConflicts = uniquePendingConflicts(
              batch.plans.flatMap((plan) => pendingConflictsByPlan.get(plan) ?? []),
            );
            for (const pendingConflict of batchPendingConflicts) {
              await this.pendingMutations.applyPreparedPendingConflict(store, pendingConflict);
            }
            await this.applyAdoptedLocalEntries(store, batch.plans);
            await this.clearChangingStorePaths(store, batch.plans);

            const skipRemoteWritePlans = new Set<PlannedEntryState>(
              batchPendingConflicts
                .filter((conflict) => conflict.merge?.kind === "rebase-client")
                .map((conflict) => conflict.plan),
            );

            let removed = 0;
            if (!skipDeletions) {
              for (const path of batch.pathsToRemove) {
                if (await removeVaultPathIfExists(this.deps.vaultAdapter, path)) {
                  removed += 1;
                }
              }
            }

            const writablePlans = batch.blobs.filter(({ plan }) => {
              if (!plan.finalPath) return false;
              if (skipRemoteWritePlans.has(plan)) return false;
              if (!isPathWithinSyncLimits(plan.finalPath)) {
                const detail = describePathLimit(plan.finalPath);
                console.warn(
                  `[osync:path-limit] skipping write of ${plan.finalPath}: ${
                    detail.ok ? "ok" : `${detail.reason} (${detail.byteSize}b > ${detail.limit}b)`
                  }`,
                );
                return false;
              }
              return true;
            });
            await ensureParentDirectoriesBatch(
              this.deps.vaultAdapter,
              writablePlans.map(({ plan }) => plan.finalPath!),
            );
            await mapWithConcurrency(
              writablePlans,
              FILE_WRITE_CONCURRENCY,
              async ({ plan, bytes }) => {
                const finalPath = plan.finalPath!;
                if (isMarkdownPath(finalPath)) {
                  await this.deps.vaultAdapter.writeText(
                    finalPath,
                    new TextDecoder().decode(bytes),
                  );
                } else {
                  await this.deps.vaultAdapter.writeBinary(finalPath, bytes);
                }
              },
            );

            removedTotal += removed;

            const bulkOps: BulkEntryApplyOp[] = batch.plans.map((plan) => {
              if (skipRemoteWritePlans.has(plan)) {
                // rebase-client: only refresh remote state row; preserve local
                // state and disk content reflecting the winning local edits.
                return {
                  kind: "applyRemote" as const,
                  entry: {
                    entryId: plan.state.entryId,
                    path: plan.state.deleted ? plan.metadata.path : plan.finalPath,
                    revision: plan.state.revision,
                    blobId: plan.state.deleted ? null : plan.state.blobId,
                    hash: plan.hash,
                    deleted: plan.state.deleted,
                    updatedAt: plan.state.updatedAt,
                    entryType: plan.state.entryType,
                  },
                };
              }
              return {
                kind: "upsert" as const,
                entry: {
                  entryId: plan.state.entryId,
                  path: plan.state.deleted ? plan.metadata.path : plan.finalPath,
                  revision: plan.state.revision,
                  blobId: plan.state.deleted ? null : plan.state.blobId,
                  hash: plan.hash,
                  deleted: plan.state.deleted,
                  updatedAt: plan.state.updatedAt,
                  localMtime: null,
                  localSize: null,
                  entryType: plan.state.entryType,
                },
              };
            });
            await store.bulkApply(bulkOps);
            for (const pendingConflict of batchPendingConflicts) {
              await this.pendingMutations.applyPreparedPendingMerge(store, pendingConflict);
            }

            entriesApplied += batch.plans.length;
            await this.deps.onProgress?.({
              completedEntries: (progress?.completedOffset ?? 0) + entriesApplied,
              totalEntries: progress?.totalEntries ?? prepared.plans.length,
            });
          }

          // Folder pass: create new folders and safe-delete removed/renamed ones.
          const foldersToDelete: string[] = [];
          for (const plan of prepared.plans) {
            if (plan.state.entryType !== "folder") {
              continue;
            }

            if (plan.state.deleted) {
              const deletePath = plan.existing?.path ?? plan.metadata.path;
              if (deletePath) {
                foldersToDelete.push(deletePath);
              }
            } else if (plan.finalPath) {
              if (!(await this.deps.vaultAdapter.exists(plan.finalPath))) {
                await this.deps.vaultAdapter.mkdir(plan.finalPath);
              }
              const oldPath = plan.existing?.path;
              if (oldPath && oldPath !== plan.finalPath) {
                foldersToDelete.push(oldPath);
              }
            }
          }

          if (!skipDeletions) {
            foldersToDelete.sort((a, b) => {
              const aDepth = (a.match(/\//g) ?? []).length;
              const bDepth = (b.match(/\//g) ?? []).length;
              return bDepth - aDepth;
            });
            for (const folderPath of foldersToDelete) {
              await this.safeDeleteFolder(folderPath);
            }
          }

          return removedTotal;
        },
      );

      return filesDeleted;
    } catch (error) {
      await this.restoreManifestEntries(store, originalEntries);
      await this.restoreDirtyEntries(store, originalDirtyEntries);
      throw error;
    }
  }

  private async applyAdoptedLocalEntries(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
  ): Promise<void> {
    const adoptedEntryIds = new Set<string>();

    for (const plan of plans) {
      const adoption = plan.adoptedLocalEntry;
      if (!adoption || adoptedEntryIds.has(adoption.entry.entryId)) {
        continue;
      }

      if (adoption.hashMatches) {
        await store.clearDirtyEntryByMutationId(adoption.pending.mutationId);
      }
      await store.deleteEntry(adoption.entry.entryId);
      adoptedEntryIds.add(adoption.entry.entryId);
    }
  }

  private async clearChangingStorePaths(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
  ): Promise<void> {
    for (const plan of plans) {
      if (!plan.existing?.path || plan.existing.path === plan.finalPath) {
        continue;
      }

      await store.upsertEntry({
        ...plan.existing,
        path: null,
        localMtime: null,
        localSize: null,
      });
    }
  }

  private async snapshotManifestEntries(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
  ): Promise<Map<string, SnapshotEntryState>> {
    const entryIds = new Set<string>();
    for (const plan of plans) {
      entryIds.add(plan.state.entryId);
      if (plan.adoptedLocalEntry) {
        entryIds.add(plan.adoptedLocalEntry.entry.entryId);
      }
    }

    const entries = new Map<string, SnapshotEntryState>();
    for (const entryId of entryIds) {
      entries.set(entryId, {
        remote: await store.getRemoteStateById(entryId),
        local: await store.getLocalStateById(entryId),
      });
    }
    return entries;
  }

  private async snapshotDirtyEntries(
    store: PullEntryStateStore,
    prepared: PreparedManifestApplication,
  ): Promise<Map<string, PendingMutationRow | null>> {
    const entryIds = new Set<string>();
    for (const plan of prepared.plans) {
      entryIds.add(plan.state.entryId);
      if (plan.adoptedLocalEntry) {
        entryIds.add(plan.adoptedLocalEntry.entry.entryId);
      }
    }
    for (const pendingConflict of prepared.pendingConflicts) {
      entryIds.add(pendingConflict.pending.entryId);
    }

    const dirtyEntries = new Map<string, PendingMutationRow | null>();
    for (const entryId of entryIds) {
      dirtyEntries.set(entryId, await store.getDirtyEntryMutation(entryId));
    }
    return dirtyEntries;
  }

  private async restoreManifestEntries(
    store: PullEntryStateStore,
    entries: ReadonlyMap<string, SnapshotEntryState>,
  ): Promise<void> {
    for (const [entryId, entry] of entries) {
      if (entry.remote) {
        await store.applyRemoteState(entry.remote);
      } else {
        await store.clearRemoteState(entryId);
      }

      if (entry.local) {
        await store.applyLocalState(entry.local);
      } else {
        await store.clearLocalState(entryId);
      }

      if (!entry.remote && !entry.local && !(await store.getDirtyEntryMutation(entryId))) {
        await store.deleteEntry(entryId);
      }
    }
  }

  private async restoreDirtyEntries(
    store: PullEntryStateStore,
    entries: ReadonlyMap<string, PendingMutationRow | null>,
  ): Promise<void> {
    for (const [entryId, mutation] of entries) {
      const current = await store.getDirtyEntryMutation(entryId);
      if (current) {
        await store.clearDirtyEntryByMutationId(current.mutationId);
      }
      if (mutation) {
        await store.markEntryDirty(mutation);
      }
    }
  }

  private async safeDeleteFolder(path: string): Promise<void> {
    if (
      (await this.deps.vaultAdapter.exists(path)) &&
      (await this.deps.vaultAdapter.isFolderEmpty(path))
    ) {
      await this.deps.vaultAdapter.remove(path);
    }
  }

  private async runWithSuppressedPaths<T>(
    paths: ReadonlyArray<string | null | undefined>,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!this.deps.eventGate) {
      return await action();
    }

    return await this.deps.eventGate.suppressPaths(uniqueSyncPaths(paths), action);
  }
}

function collectFolderPathsForSuppression(
  plans: ReadonlyArray<PlannedEntryState>,
): string[] {
  const paths: string[] = [];
  for (const plan of plans) {
    if (plan.state.entryType !== "folder") {
      continue;
    }
    if (plan.state.deleted) {
      const deletePath = plan.existing?.path ?? plan.metadata.path;
      if (deletePath) {
        paths.push(deletePath);
      }
    } else {
      if (plan.finalPath) {
        paths.push(plan.finalPath);
      }
      if (plan.existing?.path && plan.existing.path !== plan.finalPath) {
        paths.push(plan.existing.path);
      }
    }
  }
  return paths;
}
