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
  now?: () => number;
}

export interface SyncPushStore
  extends SyncCursorStore,
    Pick<SyncEntryStore, "countSyncProgress">,
    Pick<
      SyncMutationStore,
      "listDirtyEntries" | "unblockDirtyEntriesByReason"
    >,
    Pick<SyncStoreLifecycle, "flush">,
    PushMutationStore {}

export interface PushPendingMutationsResult {
  cursor: number;
  mutationsPushed: number;
  mutationsRequeued: number;
  filesCreatedOrUpdated: number;
  filesDeleted: number;
  conflictsCreated: number;
  shouldPullAfterPush: boolean;
  hasMore: boolean;
}

export class SyncPushService {
  private readonly mutationCommitter: PushMutationCommitter;

  constructor(private readonly deps: SyncPushServiceDeps) {
    this.mutationCommitter = new PushMutationCommitter({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      crypto: this.deps.crypto,
      fileReader: this.deps.fileReader,
      conflictFileWriter: this.deps.conflictFileWriter,
      blobClient: this.deps.blobClient,
      onConflict: this.deps.onConflict,
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
    let filesCreatedOrUpdated = 0;
    let filesDeleted = 0;
    let conflictsCreated = 0;
    let shouldPullAfterPush = false;
    let processedMutations = 0;
    let hasMore = false;
    let stopAfterCurrentBatch = false;

    try {
      if (
        session.storageLimitBytes <= 0 ||
        session.storageUsedBytes < session.storageLimitBytes
      ) {
        await store.unblockDirtyEntriesByReason("storage_quota_exceeded");
      }

      while (processedMutations < DEFAULT_PUSH_DRAIN_LIMIT) {
        const remainingBudget = DEFAULT_PUSH_DRAIN_LIMIT - processedMutations;
        const pending = await store.listDirtyEntries(
          Math.min(DEFAULT_PUSH_BATCH, remainingBudget),
        );
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
        if (!stopAfterCurrentBatch) {
          await store.setCursor(cursor);
        }
        await this.reportProgress(store);
        if (stopAfterCurrentBatch) {
          break;
        }
      }

      hasMore = (await store.listDirtyEntries(1)).length > 0;
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
      filesCreatedOrUpdated,
      filesDeleted,
      conflictsCreated,
      shouldPullAfterPush,
      hasMore,
    };
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

