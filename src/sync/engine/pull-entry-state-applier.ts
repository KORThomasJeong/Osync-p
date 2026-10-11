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
  ensureParentDirectories,
  ensureParentDirectoriesBatch,
  isMarkdownPath,
  removeVaultPathIfExists,
  type SyncVaultWriter,
} from "../vault/vault-writer";
import { matchesSyncFileRules, type SyncFileRules } from "../core/file-rules";
import {
  describeDeviceWriteIssue,
  type DevicePathPolicy,
} from "../core/path-portability";
import type { SyncEventGateLike } from "./event-gate";
import { PullBlobPreparer } from "./pull-blob-preparer";
import { PullManifestPlanner, type PullManifestStore } from "./pull-manifest-planner";
import { PullPendingMutationHandler } from "./pull-pending-mutation-handler";
import { detachLocalEntries, isUnreadablePlaceholderPath } from "./unreadable-entries";
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
  // Notified (best-effort) when a remote entry could not be decrypted and was
  // quarantined, so callers can surface a diagnostic. Never throws the pull.
  onDecryptFailure?: (entryId: string) => void;
  // Notified (best-effort) for every remote entry whose metadata decrypted, so a
  // previously recorded decrypt failure for it can be cleared.
  onEntryDecrypted?: (entryId: string) => void;
  // A queued local change whose metadata the current key cannot decrypt was dropped
  // because the remote changed the same entry (see undecryptable-pending.ts).
  onUndecryptablePendingDropped?: (mutation: PendingMutationRow) => void;
  // When provided, remote entries whose path is not syncable on this device
  // (e.g. inside an excluded folder) are recorded in the store but never written
  // to or deleted from disk — so they stop churning the vault while still
  // advancing the cursor. Omit to treat every path as syncable (legacy behavior).
  getSyncFileRules?: () => SyncFileRules;
  // Whether this device can hold a path at all (Windows-invalid names, path limits,
  // paths whose write already failed here). Unwritable paths are handled exactly like
  // excluded ones. Omit to apply only the default path limits.
  getDevicePathPolicy?: () => DevicePathPolicy;
  // Best-effort report, after a window applied, of entries this device skipped or
  // failed to write — and of entries that applied normally, so stale reports clear.
  onDeviceIssue?: (event: PullDeviceIssueEvent) => void;
}

export type PullDeviceIssueEvent =
  | {
      // skipped: the path cannot exist on this device, so it was never attempted.
      // write_failed: the write was attempted and threw.
      kind: "skipped" | "write_failed";
      entryId: string;
      path: string;
      reason: string;
    }
  | { kind: "resolved"; entryId: string; path: string };

type DeviceSkipOutcome = {
  kind: "skipped" | "write_failed";
  path: string;
  reason: string;
};

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

  // A remote path that this device's file rules exclude (e.g. an excluded folder), or
  // that this device cannot hold (see describeDeviceIssue), must not touch the disk on
  // pull. The remote state is still recorded so the cursor advances and the entry is
  // not re-downloaded on every subsequent pull.
  private isDiskWritablePath(path: string | null | undefined): boolean {
    if (!path) return false;
    if (!this.matchesUserRules(path)) return false;
    return this.describeDeviceIssue(path) === null;
  }

  private matchesUserRules(path: string): boolean {
    const getRules = this.deps.getSyncFileRules;
    return !getRules || matchesSyncFileRules(path, getRules());
  }

  private describeDeviceIssue(path: string): string | null {
    const policy = this.deps.getDevicePathPolicy?.();
    return policy
      ? policy.describeUnwritable(path)
      : describeDeviceWriteIssue(path, { isWin: false });
  }

  // For a path the user's rules include: why this device cannot hold it, if it can't.
  // User-excluded paths are not device issues and return null.
  private deviceSkipOutcome(path: string): DeviceSkipOutcome | null {
    if (!this.matchesUserRules(path)) return null;
    const reason = this.describeDeviceIssue(path);
    return reason ? { kind: "skipped", path, reason } : null;
  }

  private reportOutcomes(
    plans: ReadonlyArray<PlannedEntryState>,
    outcomes: ReadonlyMap<PlannedEntryState, DeviceSkipOutcome>,
  ): void {
    const report = this.deps.onDeviceIssue;
    if (!report) return;
    for (const plan of plans) {
      const outcome = outcomes.get(plan);
      try {
        report(
          outcome
            ? { ...outcome, entryId: plan.state.entryId }
            : {
                kind: "resolved",
                entryId: plan.state.entryId,
                path: plan.finalPath ?? plan.metadata.path,
              },
        );
      } catch (error) {
        console.error("[osync] pull: device issue listener failed", error);
      }
    }
  }

  async createManifestItems(
    states: RemoteEntryState[],
  ): Promise<PullEntryStateManifestItem[]> {
    const items = await mapWithConcurrency(
      states,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (state): Promise<PullEntryStateManifestItem | null> => {
        let metadata: PullEntryStateManifestItem["metadata"];
        try {
          metadata = await this.deps.crypto.decryptMetadata(
            state.encryptedMetadata,
            metadataContextFromRemoteState(state),
          );
        } catch (error) {
          // One undecryptable entry (key rotation, corrupt ciphertext, a poisoned row)
          // must not abort the whole page — that would stall the pull at this cursor and
          // re-fail forever. Quarantine it and keep applying the healthy entries.
          const ctx = metadataContextFromRemoteState(state);
          console.error(
            `[osync] pull: quarantining undecryptable remote entry ${ctx.entryId} rev=${ctx.revision} op=${ctx.op} blobId=${ctx.blobId ?? "null"}`,
            error,
          );
          this.deps.onDecryptFailure?.(ctx.entryId);
          return null;
        }
        try {
          this.deps.onEntryDecrypted?.(state.entryId);
        } catch (error) {
          console.error("[osync] pull: decrypt listener failed", error);
        }
        const malformed = describeMalformedEntryState(state, metadata);
        if (malformed) {
          // Like an undecryptable entry: applying it would throw for the whole window
          // and stall the pull at this cursor forever. Skip it; nothing local changes.
          console.error(
            `[osync] pull: skipping malformed remote entry ${state.entryId} rev=${state.revision}: ${malformed}`,
          );
          return null;
        }
        return { state, metadata };
      },
    );
    return items.filter((item): item is PullEntryStateManifestItem => item !== null);
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
    manifest = await this.setAsideUnreadablePlaceholders(store, manifest);
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

  // A removed unreadable entry carries a placeholder path, not a real one (see
  // unreadable-entries.ts). It must never touch the disk: not written, and never a
  // reason to remove a file — even when this device still maps the entry to a real
  // local file (the device that wrote it with the wrong key, or one that had an older
  // readable revision). Such a mapping is forgotten instead, so the local file is
  // uploaded again as a new entry by the next scan.
  private async setAsideUnreadablePlaceholders(
    store: PullEntryStateStore,
    manifest: PullEntryStateManifestItem[],
  ): Promise<PullEntryStateManifestItem[]> {
    const placeholders = manifest.filter((item) => isUnreadablePlaceholderPath(item.metadata.path));
    if (placeholders.length === 0) {
      return manifest;
    }
    const detached = await detachLocalEntries(
      store,
      placeholders.map((item) => item.state.entryId),
    );
    if (detached.length > 0) {
      console.info(
        `[osync] pull: ${detached.length} removed unreadable entr${detached.length === 1 ? "y" : "ies"} forgotten locally; local files are kept and will upload as new entries`,
      );
    }
    return manifest.filter((item) => !isUnreadablePlaceholderPath(item.metadata.path));
  }

  private async prepareManifestApplication(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    manifest: PullEntryStateManifestItem[],
    options: { deferExternalPathOwners: boolean },
  ): Promise<PreparedManifestApplication> {
    const { plans: plannedEntries, deferred } = await this.manifestPlanner.planManifest(
      store,
      manifest,
      options,
    );
    const preparedBlobs = await this.blobPreparer.preparePathBatchBlobs(
      store,
      token,
      plannedEntries,
    );
    const blobByPlan = new Map(preparedBlobs.map((blob) => [blob.plan, blob]));

    // A plan whose blob was quarantined (permanent download-verification failure)
    // has no prepared blob. Drop it so it is neither written to disk nor recorded
    // in the store — the healthy entries still apply and the cursor advances past
    // the poison entry instead of re-downloading the whole batch forever.
    const plans = plannedEntries.filter((plan) => {
      const needsBlob =
        !!plan.finalPath &&
        !plan.state.deleted &&
        plan.state.entryType !== "folder";
      return !needsBlob || blobByPlan.has(plan);
    });
    const pathsToWrite = uniqueSyncPaths(plans.map((plan) => plan.finalPath));
    const pendingConflicts: PreparedPendingConflict[] = [];
    const preparedPendingMutationIds = new Set<string>();
    const batches: PreparedPathBatch[] = [];

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

    // Per-plan device outcome; absent = applied normally.
    const outcomes = new Map<PlannedEntryState, DeviceSkipOutcome>();

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
                // Never touch the disk for paths excluded on (or unwritable by) this
                // device — on Windows even exists() can throw for an invalid name.
                if (!this.isDiskWritablePath(path)) continue;
                try {
                  if (await removeVaultPathIfExists(this.deps.vaultAdapter, path)) {
                    removed += 1;
                  }
                } catch (error) {
                  // A locked/undeletable file must not stall the pull at this cursor
                  // forever. The stale file stays on disk for the next local scan.
                  console.warn(`[osync] pull: could not remove ${path}`, error);
                }
              }
            }

            // Plans this device does not hold on disk (skipped as unwritable, or whose
            // write failed) record only their remote state; see bulkOps below.
            const remoteOnlyPlans = new Set<PlannedEntryState>();
            const writablePlans = batch.blobs.filter(({ plan }) => {
              if (!plan.finalPath) return false;
              if (skipRemoteWritePlans.has(plan)) return false;
              if (!this.isDiskWritablePath(plan.finalPath)) {
                const skip = this.deviceSkipOutcome(plan.finalPath);
                if (skip) {
                  console.warn(`[osync] pull: skipping write of ${skip.path}: ${skip.reason}`);
                  outcomes.set(plan, skip);
                  remoteOnlyPlans.add(plan);
                }
                return false;
              }
              return true;
            });
            // One file that cannot be written on this device (a name the OS rejects, a
            // locked file, a failed mkdir) must not throw the whole window: that rolls
            // everything back and re-downloads the same blobs forever. Isolate the
            // failure to its own entry and let the rest of the window apply.
            let parentsReady = true;
            try {
              await ensureParentDirectoriesBatch(
                this.deps.vaultAdapter,
                writablePlans.map(({ plan }) => plan.finalPath!),
              );
            } catch {
              // Retry per file below so only the files under the failing folder fail.
              parentsReady = false;
            }
            await mapWithConcurrency(
              writablePlans,
              // Per-file mkdir of shared parents must not race.
              parentsReady ? FILE_WRITE_CONCURRENCY : 1,
              async ({ plan, bytes }) => {
                const finalPath = plan.finalPath!;
                try {
                  if (!parentsReady) {
                    await ensureParentDirectories(this.deps.vaultAdapter, finalPath);
                  }
                  if (isMarkdownPath(finalPath)) {
                    await this.deps.vaultAdapter.writeText(
                      finalPath,
                      new TextDecoder().decode(bytes),
                    );
                  } else {
                    await this.deps.vaultAdapter.writeBinary(finalPath, bytes);
                  }
                } catch (error) {
                  console.error(`[osync] pull: could not write ${finalPath}`, error);
                  remoteOnlyPlans.add(plan);
                  outcomes.set(plan, {
                    kind: "write_failed",
                    path: finalPath,
                    reason: describeWriteError(error),
                  });
                }
              },
            );

            removedTotal += removed;

            const bulkOps: BulkEntryApplyOp[] = batch.plans.map((plan) => {
              // A device-skipped or failed write records only the remote state and leaves
              // the local state as it was (no row at all for a new file), so the entry is
              // never "known locally but missing" — which the next scan would push as a
              // delete — even if the device exclusion is later lifted or lost.
              if (skipRemoteWritePlans.has(plan) || remoteOnlyPlans.has(plan)) {
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
              if (deletePath && this.isDiskWritablePath(deletePath)) {
                foldersToDelete.push(deletePath);
              }
            } else if (plan.finalPath) {
              if (this.isDiskWritablePath(plan.finalPath)) {
                try {
                  if (!(await this.deps.vaultAdapter.exists(plan.finalPath))) {
                    await this.deps.vaultAdapter.mkdir(plan.finalPath);
                  }
                } catch (error) {
                  console.error(
                    `[osync] pull: could not create folder ${plan.finalPath}`,
                    error,
                  );
                  outcomes.set(plan, {
                    kind: "write_failed",
                    path: plan.finalPath,
                    reason: describeWriteError(error),
                  });
                  await this.forgetLocalFolderPath(store, plan.state.entryId);
                }
              } else {
                const skip = this.deviceSkipOutcome(plan.finalPath);
                if (skip) {
                  outcomes.set(plan, skip);
                  await this.forgetLocalFolderPath(store, plan.state.entryId);
                }
              }
              const oldPath = plan.existing?.path;
              if (oldPath && oldPath !== plan.finalPath && this.isDiskWritablePath(oldPath)) {
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
              try {
                await this.safeDeleteFolder(folderPath);
              } catch (error) {
                console.warn(`[osync] pull: could not remove folder ${folderPath}`, error);
              }
            }
          }

          return removedTotal;
        },
      );

      this.reportOutcomes(prepared.plans, outcomes);
      return filesDeleted;
    } catch (error) {
      await this.restoreManifestEntries(store, originalEntries);
      await this.restoreDirtyEntries(store, originalDirtyEntries);
      throw error;
    }
  }

  // Same rule as a device-skipped or failed file write: a folder this device does not
  // hold must not stay recorded as present locally, or the next scan propagates its
  // absence as a delete. (Folder rows were already upserted with the batch.)
  private async forgetLocalFolderPath(
    store: PullEntryStateStore,
    entryId: string,
  ): Promise<void> {
    const local = await store.getLocalStateById(entryId);
    if (local?.path) {
      await store.applyLocalState({ ...local, path: null });
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

// The invariants the manifest planner relies on (it throws when one is broken).
function describeMalformedEntryState(
  state: RemoteEntryState,
  metadata: PullEntryStateManifestItem["metadata"],
): string | null {
  if (state.entryType === "folder") {
    return null;
  }
  if (state.deleted) {
    return metadata.hash !== null ? "deleted file has a hash" : null;
  }
  if (!state.blobId) {
    return "file is missing a blob";
  }
  if (!metadata.hash) {
    return "file is missing a hash";
  }
  return null;
}

function describeWriteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
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
