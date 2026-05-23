import type {
  CommitAcceptedResult,
  CommitMutationPayload,
  CommitMutationsResult,
  EntryVersionPageCursor,
  EntryVersionRestoredResponse,
  EntryVersionsResponse,
  HelloAckMessage,
  RealtimeSessionState,
  SyncRealtimeSession,
  SyncStorageStatus,
} from "./realtime-types";
import { SyncRealtimeError } from "./realtime-types";
import type { EntryStatePageCursor, ListEntryStatesResponse } from "./changes";
import type { SyncRealtimeSocketSession } from "./realtime-socket-session";

export function applySessionStorageLimit(
  status: SyncStorageStatus,
  storageLimitBytes: number,
): SyncStorageStatus {
  return {
    storageUsedBytes: status.storageUsedBytes,
    storageLimitBytes,
  };
}

export class SyncRealtimeApiSession implements SyncRealtimeSession {
  readonly serverCursor: number;
  readonly maxFileSizeBytes: number;

  constructor(
    private readonly transport: SyncRealtimeSocketSession,
    hello: HelloAckMessage,
    private readonly state: RealtimeSessionState,
  ) {
    this.serverCursor = hello.cursor;
    this.maxFileSizeBytes = hello.policy.maxFileSizeBytes;
  }

  get storageUsedBytes(): number {
    return this.state.storageStatus.storageUsedBytes;
  }

  get storageLimitBytes(): number {
    return this.state.storageStatus.storageLimitBytes;
  }

  watchStorageStatus(): void {
    this.transport.send({
      type: "watch_storage_status",
    });
  }

  unwatchStorageStatus(): void {
    this.transport.send({
      type: "unwatch_storage_status",
    });
  }

  async listEntryStates(input: {
    sinceCursor: number;
    targetCursor: number | null;
    after: EntryStatePageCursor | null;
    limit: number;
  }): Promise<ListEntryStatesResponse> {
    const message = await this.transport.request({
      type: "list_entry_states",
      sinceCursor: input.sinceCursor,
      targetCursor: input.targetCursor,
      after: input.after,
      limit: input.limit,
    });

    if (message.type !== "entry_states_listed") {
      throw new Error("list entry states did not produce an entry_states_listed response");
    }

    return {
      targetCursor: message.targetCursor,
      totalEntries: message.totalEntries,
      hasMore: message.hasMore,
      nextAfter: message.nextAfter,
      entries: message.entries,
    };
  }

  async listEntryVersions(input: {
    entryId: string;
    before: EntryVersionPageCursor | null;
    limit: number;
  }): Promise<EntryVersionsResponse> {
    const message = await this.transport.request({
      type: "list_entry_versions",
      entryId: input.entryId,
      before: input.before,
      limit: input.limit,
    });

    if (message.type !== "entry_versions_listed") {
      throw new Error("list entry versions did not produce an entry_versions_listed response");
    }

    return {
      entryId: message.entryId,
      versions: message.versions,
      hasMore: message.hasMore,
      nextBefore: message.nextBefore,
    };
  }

  async restoreEntryVersion(input: {
    entryId: string;
    versionId: string;
    baseRevision: number;
    op: "upsert" | "delete";
    blobId: string | null;
    encryptedMetadata: string;
  }): Promise<EntryVersionRestoredResponse> {
    const message = await this.transport.request({
      type: "restore_entry_version",
      entryId: input.entryId,
      versionId: input.versionId,
      baseRevision: input.baseRevision,
      op: input.op,
      blobId: input.blobId,
      encryptedMetadata: input.encryptedMetadata,
    });

    if (message.type !== "entry_version_restored") {
      throw new Error("restore entry version did not produce an entry_version_restored response");
    }

    return {
      entryId: message.entryId,
      restoredFromVersionId: message.restoredFromVersionId,
      restoredFromRevision: message.restoredFromRevision,
      cursor: message.cursor,
      revision: message.revision,
    };
  }

  async ackCursor(cursor: number): Promise<void> {
    const message = await this.transport.request({
      type: "ack_cursor",
      cursor,
    });

    if (message.type !== "cursor_acked") {
      throw new Error("cursor ack did not produce a cursor_acked response");
    }
  }

  async commitMutation(mutation: CommitMutationPayload): Promise<CommitAcceptedResult> {
    const batch = await this.commitMutations([mutation]);
    const result = batch.results[0];
    if (!result) {
      throw new Error("commit batch returned no result");
    }

    if (result.status === "rejected") {
      throw new SyncRealtimeError(result.code, result.message, {
        expectedBaseRevision: result.expectedBaseRevision,
        receivedBaseRevision: result.receivedBaseRevision,
      });
    }
    return {
      cursor: result.cursor,
      entryId: result.entryId,
      revision: result.revision,
    };
  }

  async commitMutations(
    mutations: CommitMutationPayload[],
  ): Promise<CommitMutationsResult> {
    const message = await this.transport.request({
      type: "commit_mutations",
      mutations,
    });

    if (message.type !== "commit_mutations_committed") {
      throw new Error("commit batch did not produce a commit_mutations_committed response");
    }

    return {
      cursor: message.cursor,
      results: message.results,
    };
  }

  close(): void {
    this.transport.close();
  }
}


