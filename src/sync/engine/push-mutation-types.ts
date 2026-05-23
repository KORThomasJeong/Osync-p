import type { SyncBlobClient } from "../remote/blob-client";
import type { ConflictFileWriter } from "../core/conflict-file";
import type { SyncCryptoService } from "../core/crypto-service";
import type {
  CommitAcceptedResult,
  CommitMutationPayload,
} from "../remote/realtime-client";
import type {
  SyncBlobStore,
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
} from "../store/ports";
import type { SyncProgressCounts } from "../store/store";
import type { ConflictResolutionPolicy } from "./conflict-resolution-policy";

export interface PushMutationCommitterDeps {
  getApiBaseUrl: () => string;
  crypto: SyncCryptoService;
  conflictPolicy?: ConflictResolutionPolicy;
  fileReader: LocalFileReader;
  conflictFileWriter?: ConflictFileWriter;
  blobClient?: SyncBlobClient;
  onConflict?: (event: PushConflictEvent) => void;
  now?: () => number;
}

export interface LocalFileReader {
  readBytes(path: string): Promise<Uint8Array>;
}

export interface PushConflictEvent {
  entryId: string;
  op: "upsert" | "delete";
  originalPath: string;
  conflictPath: string | null;
}

export type PushMutationCommitResult =
  | {
      status: "accepted";
      accepted: CommitAcceptedResult;
      filesCreatedOrUpdated: number;
      filesDeleted: number;
      conflictsCreated: 0;
      shouldPullAfterPush: false;
    }
  | {
      status: "requeued";
      filesCreatedOrUpdated: 0;
      filesDeleted: 0;
      conflictsCreated: 0;
      shouldPullAfterPush: false;
    }
  | {
      status: "conflict";
      filesCreatedOrUpdated: 0;
      filesDeleted: 0;
      conflictsCreated: number;
      shouldPullAfterPush: false;
    }
  | {
      status: "stale";
      filesCreatedOrUpdated: 0;
      filesDeleted: 0;
      conflictsCreated: 0;
      shouldPullAfterPush: true;
    };

export interface PreparedPushMutation {
  commitPayload: CommitMutationPayload;
  localHash: string | null;
  encryptedBytes: Uint8Array | null;
  storageBytesAdded: number;
}

export interface PushMutationStore
  extends Pick<SyncEntryStore, "getEntryById" | "deleteEntry">,
    Pick<SyncRemoteEntryStore, "applyRemoteState" | "getRemoteStateById">,
    Pick<SyncLocalEntryStore, "applyLocalState" | "getLocalStateById">,
    Pick<
      SyncMutationStore,
      | "clearDirtyEntryByMutationId"
      | "getDirtyEntryMutation"
      | "replaceDirtyEntry"
      | "updateDirtyEntry"
    >,
    Pick<SyncBlobStore, "putBlob"> {}

export interface SkippedPushMutation {
  skipped: true;
  reason: "file_too_large" | "storage_quota_exceeded";
}

export type PreparePushMutationResult = PreparedPushMutation | SkippedPushMutation | null;

export type PushProgressReporter = (progress: SyncProgressCounts) => Promise<void>;
