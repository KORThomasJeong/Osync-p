import { mapWithConcurrency } from "../core/concurrency";
import { SyncBlobClient } from "../remote/blob-client";
import type { ConflictFileWriter } from "../core/conflict-file";
import type { SyncCryptoService } from "../core/crypto-service";
import type { SyncTokenResponse } from "../remote/client";
import type { SyncRealtimeSession } from "../remote/realtime-client";
import type {
  PendingMutationRow,
  SyncProgressCounts,
} from "../store/store";
import type { CommitMutationBatchResult } from "../remote/realtime-client";
import type {
  StaleEntryResolver,
  StaleEntryResolverStore,
  StaleEntryTarget,
} from "./stale-entry-resolver";
import { tryDecryptPendingMetadata } from "./undecryptable-pending";
import type {
  SyncCursorStore,
  SyncEntryStore,
  SyncMutationStore,
  SyncStoreLifecycle,
} from "../store/ports";
import {
  type LocalFileReader,
  PushMutationCommitter,
  type PushConflictEvent,
  type PushMutationStore,
  type PreparedPushMutation,
} from "./push-mutation-committer";

const DEFAULT_PUSH_BATCH = 100;
const DEFAULT_PUSH_DRAIN_LIMIT = 1_000;
const DEFAULT_PUSH_PREPARE_CONCURRENCY = 36;

export interface SyncPushServiceDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncPushStore | null;
  crypto: SyncCryptoService;
  fileReader: LocalFileReader;
  conflictFileWriter?: ConflictFileWriter;
  blobClient?: SyncBlobClient;
  prepareConcurrency?: number;
  onProgress: (progress: SyncProgressCounts) => Promise<void>;
  onConflict?: (event: PushConflictEvent) => void;
  // A queued change whose metadata the current key cannot decrypt was dropped; the
  // caller re-scans local files so it is queued again with the current key.
  onUndecryptablePendingDropped?: (mutation: PendingMutationRow) => void;
  // Resolves stale commits the follow-up pull could not (see stale-entry-resolver.ts).
  staleEntryResolver?: Pick<StaleEntryResolver, "resolve">;
  // A change the server rejected MAX_CONSECUTIVE_REJECTIONS times in a row was blocked.
  onMutationBlocked?: (event: BlockedMutationEvent) => void;
  now?: () => number;
}

export interface BlockedMutationEvent {
  entryId: string;
  path: string | null;
  code: string;
  rejections: number;
}

// A rejected change is retried (the first stale rejection via a pull, later ones by
// reading the entry's server state directly). If the server still rejects it this
// many times in a row, it is blocked instead of hot-looping the push.
export const MAX_CONSECUTIVE_REJECTIONS = 5;
// From this rejection on, a stale change is resolved against the entry's server state.
const DIRECT_STALE_RESOLUTION_AFTER = 2;

export interface SyncPushStore
  extends SyncCursorStore,
    Pick<SyncEntryStore, "countSyncProgress">,
    Pick<
      SyncMutationStore,
      "listDirtyEntries" | "unblockDirtyEntriesByReason"
    >,
    Pick<SyncStoreLifecycle, "flush">,
    StaleEntryResolverStore,
    PushMutationStore {}

export interface PushPendingMutationsResult {
  cursor: number;
  mutationsPushed: number;
  mutationsRequeued: number;
  // Queued changes dropped because this device's key cannot decrypt them.
  mutationsDropped: number;
  filesCreatedOrUpdated: number;
  filesDeleted: number;
  conflictsCreated: number;
  shouldPullAfterPush: boolean;
  hasMore: boolean;
}

export class SyncPushService {
  private readonly mutationCommitter: PushMutationCommitter;
  // Consecutive rejections per entry since its last accepted commit (this session).
  private readonly rejectionStreaks = new Map<string, number>();

  constructor(private readonly deps: SyncPushServiceDeps) {
    this.mutationCommitter = new PushMutationCommitter({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      crypto: this.deps.crypto,
      fileReader: this.deps.fileReader,
      conflictFileWriter: this.deps.conflictFileWriter,
      blobClient: this.deps.blobClient,
      onConflict: this.deps.onConflict,
      onUndecryptablePendingDropped: this.deps.onUndecryptablePendingDropped,
      now: this.deps.now,
    });
  }

  async pushPendingMutations(
    session: SyncRealtimeSession,
  ): Promise<PushPendingMutationsResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const initialDirty = await store.listDirtyEntries(1000);
    console.log(`[osync] push start dirty=${initialDirty.length}`);
    let cursor = await store.getCursor();
    let mutationsPushed = 0;
    let mutationsRequeued = 0;
    let mutationsDropped = 0;
    let filesCreatedOrUpdated = 0;
    let filesDeleted = 0;
    let conflictsCreated = 0;
    let shouldPullAfterPush = false;
    let processedMutations = 0;
    let hasMore = false;
    let stopAfterCurrentBatch = false;
    // Queued changes whose local file could not be read during this push.
    const unreadable = new Set<string>();

    try {
      if (
        session.storageLimitBytes <= 0 ||
        session.storageUsedBytes < session.storageLimitBytes
      ) {
        await store.unblockDirtyEntriesByReason("storage_quota_exceeded");
      }

      while (processedMutations < DEFAULT_PUSH_DRAIN_LIMIT) {
        const remainingBudget = DEFAULT_PUSH_DRAIN_LIMIT - processedMutations;
        const batchSize = Math.min(DEFAULT_PUSH_BATCH, remainingBudget);
        // Changes whose file could not be read are not retried within this push.
        const pending = (await store.listDirtyEntries(batchSize + unreadable.size))
          .filter((mutation) => !unreadable.has(mutation.mutationId))
          .slice(0, batchSize);
        if (pending.length === 0) {
          hasMore = false;
          break;
        }

        // Re-fetch the token every batch. A long burst (thousands of files) can
        // outlive the ~120s token TTL; the token manager returns the cached token
        // until it nears expiry, then transparently re-issues, so blob uploads in
        // later batches never fail with 401. (P0-C)
        const token = await this.deps.getSyncToken();
        const preparedMutations = await this.preparePendingMutations(
          store,
          token,
          session,
          pending,
        );

        const committable: Array<{
          mutation: (typeof preparedMutations)[number]["mutation"];
          prepared: PreparedPushMutation;
        }> = [];

        for (const { mutation, prepared } of preparedMutations) {
          processedMutations += 1;

          if (!prepared) {
            mutationsRequeued += 1;
            continue;
          }
          if ("skipped" in prepared) {
            if (prepared.reason === "undecryptable") {
              mutationsDropped += 1;
            }
            if (prepared.reason === "local_read_failed") {
              unreadable.add(mutation.mutationId);
            }
            continue;
          }

          committable.push({ mutation, prepared });
        }

        if (committable.length === 0) {
          await this.reportProgress(store);
          continue;
        }

        const committed = await session.commitMutations(
          committable.map(({ prepared }) => prepared.commitPayload),
        );
        const resultsByMutationId = new Map(
          committed.results.map((result) => [result.mutationId, result]),
        );
        const staleTargets: StaleEntryTarget[] = [];

        for (const { mutation, prepared } of committable) {
          const batchResult = resultsByMutationId.get(mutation.mutationId);
          if (!batchResult) {
            throw new Error(`Commit batch did not include ${mutation.mutationId}.`);
          }

          const result =
            batchResult.status === "accepted"
              ? await this.mutationCommitter.applyAcceptedPreparedMutation(
                  store,
                  mutation,
                  prepared,
                  batchResult,
                )
              : await this.mutationCommitter.handleRejectedPreparedMutation(
                  store,
                  mutation,
                  batchResult,
                );
          conflictsCreated += result.conflictsCreated;
          shouldPullAfterPush = shouldPullAfterPush || result.shouldPullAfterPush;
          if (batchResult.status === "accepted") {
            this.rejectionStreaks.delete(mutation.entryId);
          } else {
            const blocked = await this.noteRejection(
              store,
              mutation,
              batchResult,
              staleTargets,
            );
            if (blocked) {
              continue;
            }
          }

          if (result.status === "stale") {
            mutationsRequeued += 1;
            stopAfterCurrentBatch = true;
            continue;
          }
          if (result.status === "requeued") {
            mutationsRequeued += 1;
            continue;
          }
          if (result.status === "conflict") {
            continue;
          }
          cursor = Math.max(cursor, result.accepted.cursor);
          filesCreatedOrUpdated += result.filesCreatedOrUpdated;
          filesDeleted += result.filesDeleted;
          mutationsPushed += 1;
        }
        await this.resolveStaleTargets(session, store, staleTargets);
        if (!stopAfterCurrentBatch) {
          await store.setCursor(cursor);
        }
        await this.reportProgress(store);
        if (stopAfterCurrentBatch) {
          break;
        }
      }

      hasMore = (await store.listDirtyEntries(unreadable.size + 1)).some(
        (mutation) => !unreadable.has(mutation.mutationId),
      );
    } finally {
      await store.flush();
    }

    console.log(
      `[osync] push done pushed=${mutationsPushed} requeued=${mutationsRequeued} stalePullNeeded=${shouldPullAfterPush}`,
    );
    return {
      cursor,
      mutationsPushed,
      mutationsRequeued,
      mutationsDropped,
      filesCreatedOrUpdated,
      filesDeleted,
      conflictsCreated,
      shouldPullAfterPush,
      hasMore,
    };
  }

  // Counts a rejection for the entry. Returns true when the change was blocked: the
  // server rejected it MAX_CONSECUTIVE_REJECTIONS times in a row. A stale change seen
  // again after the follow-up pull is queued for direct resolution.
  private async noteRejection(
    store: SyncPushStore,
    mutation: PendingMutationRow,
    rejected: Extract<CommitMutationBatchResult, { status: "rejected" }>,
    staleTargets: StaleEntryTarget[],
  ): Promise<boolean> {
    const rejections = (this.rejectionStreaks.get(mutation.entryId) ?? 0) + 1;
    this.rejectionStreaks.set(mutation.entryId, rejections);
    const current = await store.getDirtyEntryMutation(mutation.entryId);
    if (!current || current.status === "blocked") {
      // Already handled (conflict, adopt, unknown-code block): nothing to retry.
      return false;
    }

    if (rejections >= MAX_CONSECUTIVE_REJECTIONS) {
      this.rejectionStreaks.delete(mutation.entryId);
      await store.updateDirtyEntry({
        ...current,
        status: "blocked",
        blockedReason: "repeated_rejection",
      });
      const metadata = await tryDecryptPendingMetadata(this.deps.crypto, current);
      console.error(
        `[osync] push: blocking entry=${mutation.entryId} after ${rejections} rejections code=${rejected.code} expected=${rejected.expectedBaseRevision ?? "?"} received=${rejected.receivedBaseRevision ?? "?"}`,
      );
      try {
        this.deps.onMutationBlocked?.({
          entryId: mutation.entryId,
          path: metadata?.path ?? null,
          code: rejected.code,
          rejections,
        });
      } catch (error) {
        console.error("[osync] push: blocked-mutation listener failed", error);
      }
      return true;
    }

    if (
      rejections >= DIRECT_STALE_RESOLUTION_AFTER &&
      rejected.code === "stale_revision" &&
      current.mutationId === mutation.mutationId
    ) {
      staleTargets.push({
        mutation: current,
        expectedBaseRevision: rejected.expectedBaseRevision ?? null,
      });
    }
    return false;
  }

  private async resolveStaleTargets(
    session: SyncRealtimeSession,
    store: SyncPushStore,
    targets: StaleEntryTarget[],
  ): Promise<void> {
    const resolver = this.deps.staleEntryResolver;
    if (!resolver || targets.length === 0) {
      return;
    }
    try {
      await resolver.resolve(session, store, targets);
    } catch (error) {
      // Best effort: the change stays queued and the next push tries again (the
      // rejection streak still blocks it if this keeps failing).
      console.error("[osync] push: stale entry resolution failed", error);
    }
  }

  private async reportProgress(store: SyncPushStore): Promise<void> {
    const progress = await store.countSyncProgress();
    if (progress.totalEntries <= 0) {
      return;
    }

    await this.deps.onProgress(progress);
  }

  private async preparePendingMutations(
    store: SyncPushStore,
    token: SyncTokenResponse,
    session: SyncRealtimeSession,
    pending: PendingMutationRow[],
  ): Promise<
    Array<{
      mutation: (typeof pending)[number];
      prepared: Awaited<ReturnType<PushMutationCommitter["prepareMutationForCommit"]>>;
    }>
  > {
    return await mapWithConcurrency(
      pending,
      this.deps.prepareConcurrency ?? DEFAULT_PUSH_PREPARE_CONCURRENCY,
      async (mutation) => ({
        mutation,
        prepared: await this.mutationCommitter.prepareMutationForCommit(
          store,
          token,
          mutation,
          session.maxFileSizeBytes,
        ),
      }),
    );
  }
}

