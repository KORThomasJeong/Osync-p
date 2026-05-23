import { hashBytes } from "../core/content";
import type { SyncedEntryMetadata } from "../core/content";
import { writeConflictCopy } from "../core/conflict-file";
import { queueLocalUpsertMutation, resolveEditedAt } from "../core/mutation-queue";
import { SyncBlobClient, SyncBlobUploadError } from "../remote/blob-client";
import type { SyncTokenResponse } from "../remote/client";
import {
  type CommitAcceptedResult,
  type CommitMutationBatchResult,
  SyncRealtimeError,
  type SyncRealtimeSession,
} from "../remote/realtime-client";
import type { PendingMutationRow } from "../store/store";
import { decideConflictWinner } from "./conflict-tiebreak";
import {
  DefaultConflictResolutionPolicy,
  type ConflictResolutionPolicy,
} from "./conflict-resolution-policy";
import {
  isLocalAheadStaleRevision,
  isPathAlreadyExistsRejection,
  isSkippedPushMutation,
  metadataContextFromMutation,
  toCommitPayload,
} from "./push-mutation-shared";
import { isAutoMergeTextPath } from "./text-merge-policy";
import type {
  PreparedPushMutation,
  PreparePushMutationResult,
  PushConflictEvent,
  PushMutationCommitResult,
  PushMutationCommitterDeps,
  PushMutationStore,
  SkippedPushMutation,
} from "./push-mutation-types";

export type {
  LocalFileReader,
  PreparedPushMutation,
  PreparePushMutationResult,
  PushConflictEvent,
  PushMutationCommitResult,
  PushMutationCommitterDeps,
  PushMutationStore,
  SkippedPushMutation,
} from "./push-mutation-types";

export class PushMutationCommitter {
  private readonly blobClient: SyncBlobClient;
  private readonly conflictPolicy: ConflictResolutionPolicy;

  constructor(private readonly deps: PushMutationCommitterDeps) {
    this.blobClient = deps.blobClient ?? new SyncBlobClient();
    this.conflictPolicy = deps.conflictPolicy ?? new DefaultConflictResolutionPolicy();
  }

  async commitMutation(
    store: PushMutationStore,
    token: SyncTokenResponse,
    session: SyncRealtimeSession,
    mutation: PendingMutationRow,
  ): Promise<PushMutationCommitResult> {
    const prepared = await this.prepareMutationForCommit(
      store,
      token,
      mutation,
      session.maxFileSizeBytes,
    );
    if (!prepared || isSkippedPushMutation(prepared)) {
      return {
        status: "requeued",
        filesCreatedOrUpdated: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        shouldPullAfterPush: false,
      };
    }

    return await this.commitPreparedMutation(store, session, mutation, prepared);
  }

  async prepareMutationForCommit(
    store: PushMutationStore,
    token: SyncTokenResponse,
    mutation: PendingMutationRow,
    maxFileSizeBytes: number,
    storageAvailableBytes: number | null = null,
  ): Promise<PreparePushMutationResult> {
    if (mutation.op === "delete") {
      return {
        commitPayload: toCommitPayload(mutation),
        localHash: null,
        encryptedBytes: null,
        storageBytesAdded: 0,
      };
    }

    if (mutation.entryType === "folder") {
      return {
        commitPayload: toCommitPayload(mutation),
        localHash: null,
        encryptedBytes: null,
        storageBytesAdded: 0,
      };
    }

    let metadata: SyncedEntryMetadata;
    try {
      metadata = await this.deps.crypto.decryptMetadata(
        mutation.encryptedMetadata,
        metadataContextFromMutation(mutation),
      );
    } catch (error) {
      const ctx = metadataContextFromMutation(mutation);
      console.error(
        `[osync] push: failed to decrypt pending mutation ${mutation.mutationId} entry=${ctx.entryId} rev=${ctx.revision} op=${ctx.op} blobId=${ctx.blobId ?? "null"}`,
        error,
      );
      throw error;
    }
    const bytes = await this.deps.fileReader.readBytes(metadata.path);
    if (!mutation.blobId) {
      throw new Error(`Upsert mutation ${mutation.mutationId} is missing a blobId.`);
    }
    if (!mutation.hash) {
      throw new Error(`Upsert mutation ${mutation.mutationId} is missing a hash.`);
    }
    if (metadata.hash !== mutation.hash) {
      throw new Error(`Upsert mutation ${mutation.mutationId} metadata hash does not match.`);
    }
    const actualHash = await hashBytes(bytes);
    if (actualHash !== mutation.hash) {
      await this.requeueChangedUpsert(store, mutation, metadata.path, actualHash);
      return null;
    }
    const blobId = mutation.blobId;
    const encryptedBytes = await this.deps.crypto.encryptBlob(bytes, { blobId });
    const storageBytesAdded =
      mutation.blobId === mutation.baseBlobId && mutation.hash === mutation.baseHash
        ? 0
        : encryptedBytes.byteLength;
    // TODO: When paid plans can raise this limit, recheck blocked mutations
    // against the current server policy so newly allowed files can sync.
    if (maxFileSizeBytes > 0 && encryptedBytes.byteLength > maxFileSizeBytes) {
      await this.blockOversizedUpsert(store, mutation);
      return {
        skipped: true,
        reason: "file_too_large",
      };
    }
    if (
      storageAvailableBytes !== null &&
      storageBytesAdded > storageAvailableBytes
    ) {
      await this.blockQuotaExceededUpsert(store, mutation);
      return {
        skipped: true,
        reason: "storage_quota_exceeded",
      };
    }

    try {
      await this.blobClient.uploadBlob(
        this.deps.getApiBaseUrl(),
        token.token,
        token.vaultId,
        blobId,
        encryptedBytes,
      );
    } catch (error) {
      if (isQuotaExceededUploadError(error)) {
        await this.blockQuotaExceededUpsert(store, mutation);
        return {
          skipped: true,
          reason: "storage_quota_exceeded",
        };
      }

      throw error;
    }

    return {
      commitPayload: {
        ...toCommitPayload(mutation),
        blobId,
      },
      localHash: mutation.hash,
      encryptedBytes,
      storageBytesAdded,
    };
  }

  async commitPreparedMutation(
    store: PushMutationStore,
    session: SyncRealtimeSession,
    mutation: PendingMutationRow,
    prepared: PreparedPushMutation,
  ): Promise<PushMutationCommitResult> {
    let accepted;
    try {
      accepted = await session.commitMutation(prepared.commitPayload);
    } catch (error) {
      const classification = this.conflictPolicy.classify(error);
      if (classification === "stale_needs_pull") {
        return {
          status: "stale",
          filesCreatedOrUpdated: 0,
          filesDeleted: 0,
          conflictsCreated: 0,
          shouldPullAfterPush: true,
        };
      }
      if (classification === "local_ahead_conflict") {
        const handledConflict = await this.handleLocalAheadConflict(store, mutation, error);
        if (handledConflict) {
          return {
            status: "conflict",
            filesCreatedOrUpdated: 0,
            filesDeleted: 0,
            conflictsCreated: handledConflict.conflictPath ? 1 : 0,
            shouldPullAfterPush: false,
          };
        }
      }
      if (classification === "path_already_exists_adopt") {
        await this.adoptRemoteEntryId(store, mutation, error);
        return {
          status: "stale",
          filesCreatedOrUpdated: 0,
          filesDeleted: 0,
          conflictsCreated: 0,
          shouldPullAfterPush: true,
        };
      }

      throw error;
    }

    await this.applyAcceptedMutation(store, mutation, prepared, accepted);
    await store.clearDirtyEntryByMutationId(mutation.mutationId);

    return {
      status: "accepted",
      accepted,
      filesCreatedOrUpdated: mutation.op === "upsert" ? 1 : 0,
      filesDeleted: mutation.op === "delete" ? 1 : 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
    };
  }

  async applyAcceptedPreparedMutation(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    prepared: PreparedPushMutation,
    accepted: CommitAcceptedResult,
  ): Promise<PushMutationCommitResult> {
    await this.applyAcceptedMutation(store, mutation, prepared, accepted);
    await store.clearDirtyEntryByMutationId(mutation.mutationId);

    return {
      status: "accepted",
      accepted,
      filesCreatedOrUpdated: mutation.op === "upsert" ? 1 : 0,
      filesDeleted: mutation.op === "delete" ? 1 : 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
    };
  }

  async handleRejectedPreparedMutation(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    rejected: Extract<CommitMutationBatchResult, { status: "rejected" }>,
  ): Promise<PushMutationCommitResult> {
    const classification = this.conflictPolicy.classify(rejected);
    if (classification === "stale_needs_pull") {
      return {
        status: "stale",
        filesCreatedOrUpdated: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        shouldPullAfterPush: true,
      };
    }
    if (classification === "local_ahead_conflict") {
      const handledConflict = await this.handleLocalAheadConflict(
        store,
        mutation,
        rejected,
      );
      if (handledConflict) {
        return {
          status: "conflict",
          filesCreatedOrUpdated: 0,
          filesDeleted: 0,
          conflictsCreated: handledConflict.conflictPath ? 1 : 0,
          shouldPullAfterPush: false,
        };
      }
    }
    if (classification === "path_already_exists_adopt") {
      await this.adoptRemoteEntryId(store, mutation, rejected);
      return {
        status: "stale",
        filesCreatedOrUpdated: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        shouldPullAfterPush: true,
      };
    }

    console.error(
      `[osync] commit rejected entryId=${mutation.entryId} op=${mutation.op} baseRevision=${mutation.baseRevision} code=${rejected.code} message=${rejected.message}`,
    );
    throw new SyncRealtimeError(rejected.code, rejected.message);
  }

  private async applyAcceptedMutation(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    prepared: PreparedPushMutation,
    accepted: CommitAcceptedResult,
  ): Promise<void> {
    if (mutation.op === "delete") {
      const metadata = await this.deps.crypto.decryptMetadata(
        mutation.encryptedMetadata,
        metadataContextFromMutation(mutation),
      );
      await store.applyRemoteState({
        entryId: mutation.entryId,
        path: metadata.path,
        revision: accepted.revision,
        blobId: null,
        hash: null,
        deleted: true,
        updatedAt: Date.now(),
      });
      await this.applyAcceptedPendingState(store, mutation, {
        revision: accepted.revision,
        blobId: null,
        hash: null,
      });
      return;
    }

    const metadata = await this.deps.crypto.decryptMetadata(
      mutation.encryptedMetadata,
      metadataContextFromMutation(mutation),
    );
    await store.applyRemoteState({
      entryId: mutation.entryId,
      path: metadata.path,
      revision: accepted.revision,
      blobId: prepared.commitPayload.blobId,
      hash: prepared.localHash,
      deleted: false,
      updatedAt: Date.now(),
    });
    if (
      isAutoMergeTextPath(metadata.path) &&
      prepared.commitPayload.blobId &&
      prepared.encryptedBytes
    ) {
      await store.putBlob({
        blobId: prepared.commitPayload.blobId,
        hash: prepared.localHash,
        encryptedBytes: prepared.encryptedBytes,
        role: "remote",
        refEntryId: mutation.entryId,
        cachedAt: Date.now(),
      });
    }
    const local = await store.getLocalStateById(mutation.entryId);
    if (!local || (local.hash === mutation.hash && local.path === metadata.path)) {
      await store.applyLocalState({
        entryId: mutation.entryId,
        path: metadata.path,
        blobId: prepared.commitPayload.blobId,
        hash: prepared.localHash,
        deleted: false,
        updatedAt: Date.now(),
        localMtime: local?.localMtime ?? null,
        localSize: local?.localSize ?? null,
      });
    }
    await this.applyAcceptedPendingState(store, mutation, {
      revision: accepted.revision,
      blobId: prepared.commitPayload.blobId,
      hash: prepared.localHash,
    });
  }

  private async applyAcceptedPendingState(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    acceptedBase: {
      revision: number;
      blobId: string | null;
      hash: string | null;
    },
  ): Promise<void> {
    const currentPending = await store.getDirtyEntryMutation(mutation.entryId);
    if (!currentPending) {
      return;
    }

    if (currentPending.mutationId === mutation.mutationId) {
      await store.clearDirtyEntryByMutationId(mutation.mutationId);
      return;
    }

    await this.rebasePendingMutation(store, currentPending, acceptedBase);
  }

  private async rebasePendingMutation(
    store: PushMutationStore,
    pending: PendingMutationRow,
    acceptedBase: {
      revision: number;
      blobId: string | null;
      hash: string | null;
    },
  ): Promise<void> {
    const metadata = await this.deps.crypto.decryptMetadata(
      pending.encryptedMetadata,
      metadataContextFromMutation(pending),
    );
    await store.updateDirtyEntry({
      ...pending,
      baseRevision: acceptedBase.revision,
      baseBlobId: acceptedBase.blobId,
      baseHash: acceptedBase.hash,
      encryptedMetadata: await this.deps.crypto.encryptMetadata(
        metadata,
        {
          entryId: pending.entryId,
          revision: acceptedBase.revision + 1,
          op: pending.op,
          blobId: pending.blobId,
        },
      ),
    });
  }

  private async handleLocalAheadConflict(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    error: unknown,
  ): Promise<PushConflictEvent | null> {
    if (!isLocalAheadStaleRevision(error)) {
      return null;
    }

    const metadata = await this.deps.crypto.decryptMetadata(
      mutation.encryptedMetadata,
      metadataContextFromMutation(mutation),
    );
    // Server-side current revision after rollback. The error's
    // expectedBaseRevision is the server's current revision (see
    // src/sync/coordinator/store/mutation-store.ts).
    const serverRevision = error.expectedBaseRevision ?? 0;
    const remote = await store.getRemoteStateById(mutation.entryId);
    const winner = decideConflictWinner({
      serverEditedAt: undefined,
      serverUpdatedAt: remote?.updatedAt,
      serverRevision,
      clientEditedAt: metadata.editedAt,
      clientRevision: mutation.baseRevision + 1,
    });

    if (winner === "client") {
      const rebased: PendingMutationRow = {
        ...mutation,
        mutationId: crypto.randomUUID(),
        baseRevision: serverRevision,
        baseBlobId: null,
        baseHash: null,
        encryptedMetadata: await this.deps.crypto.encryptMetadata(metadata, {
          entryId: mutation.entryId,
          revision: serverRevision + 1,
          op: mutation.op,
          blobId: mutation.blobId,
        }),
      };
      await store.replaceDirtyEntry(rebased, { requireBaseBlob: false });
      const event = {
        entryId: mutation.entryId,
        op: mutation.op,
        originalPath: metadata.path,
        conflictPath: null,
      };
      this.deps.onConflict?.(event);
      return event;
    }

    const conflictPath =
      mutation.op === "upsert"
        ? await this.writeConflictCopy(
            metadata.path,
            await this.deps.fileReader.readBytes(metadata.path),
          )
        : null;

    await store.clearDirtyEntryByMutationId(mutation.mutationId);
    const event = {
      entryId: mutation.entryId,
      op: mutation.op,
      originalPath: metadata.path,
      conflictPath,
    };
    this.deps.onConflict?.(event);
    return event;
  }

  private async adoptRemoteEntryId(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    error: unknown,
  ): Promise<void> {
    const remoteEntryId = isPathAlreadyExistsRejection(error)
      ? error.conflictingEntryId
      : null;
    await store.clearDirtyEntryByMutationId(mutation.mutationId);
    await store.deleteEntry(mutation.entryId);
    if (remoteEntryId) {
      console.warn(
        `[osync] adopted remote entryId=${remoteEntryId} for path collision; dropped local entryId=${mutation.entryId}`,
      );
    } else {
      console.warn(
        `[osync] dropped local entryId=${mutation.entryId} after path_already_exists rejection without conflictingEntryId`,
      );
    }
  }

  private async blockOversizedUpsert(
    store: PushMutationStore,
    mutation: PendingMutationRow,
  ): Promise<void> {
    await store.updateDirtyEntry({
      ...mutation,
      status: "blocked",
      blockedReason: "file_too_large",
    });
  }

  private async blockQuotaExceededUpsert(
    store: PushMutationStore,
    mutation: PendingMutationRow,
  ): Promise<void> {
    await store.updateDirtyEntry({
      ...mutation,
      status: "blocked",
      blockedReason: "storage_quota_exceeded",
    });
  }

  private async requeueChangedUpsert(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    path: string,
    hash: string,
  ): Promise<void> {
    const existing = await store.getEntryById(mutation.entryId);
    const remote = await store.getRemoteStateById(mutation.entryId);
    const local = await store.getLocalStateById(mutation.entryId);
    const queued = await queueLocalUpsertMutation(store, {
      crypto: this.deps.crypto,
      path,
      entryId: mutation.entryId,
      base: remote ?? {
        revision: mutation.baseRevision,
        deleted: false,
        blobId: mutation.baseBlobId ?? mutation.blobId,
        hash: mutation.baseHash ?? mutation.hash,
      },
      previousLocal: local ?? existing,
      hash,
      editedAt: resolveEditedAt({
        now: () => Date.now(),
        fileMtime: existing?.localMtime,
      }),
    });

    await store.applyLocalState({
      entryId: queued.entryId,
      path,
      blobId: queued.blobId,
      hash,
      deleted: false,
      updatedAt: Date.now(),
      localMtime: existing?.localMtime ?? null,
      localSize: existing?.localSize ?? null,
    });
  }

  private async writeConflictCopy(path: string, bytes: Uint8Array): Promise<string> {
    const writer = this.deps.conflictFileWriter;
    if (!writer) {
      throw new Error("Conflict file writer is not configured.");
    }

    return await writeConflictCopy(writer, path, bytes, this.deps.now);
  }
}

function isQuotaExceededUploadError(error: unknown): boolean {
  return (
    error instanceof SyncBlobUploadError &&
    error.status === 413 &&
    error.code === "quota_exceeded"
  );
}
