import type {
  SyncBlobStore,
  SyncConnectionStore,
  SyncCursorStore,
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
  SyncStoreLifecycle,
} from "./ports";

export interface RemoteSyncEntryRow {
  entryId: string;
  path: string | null;
  revision: number;
  blobId: string | null;
  hash: string | null;
  deleted: boolean;
  updatedAt: number;
  entryType?: "file" | "folder";
}

export interface LocalSyncEntryRow {
  entryId: string;
  path: string | null;
  blobId: string | null;
  hash: string | null;
  deleted: boolean;
  updatedAt: number;
  localMtime: number | null;
  localSize: number | null;
  entryType?: "file" | "folder";
}

export interface SyncEntryRow extends RemoteSyncEntryRow {
  localMtime: number | null;
  localSize: number | null;
}

export interface BaseSyncEntryRow {
  entryId: string;
  path: string | null;
  revision: number;
  blobId: string | null;
  hash: string | null;
  deleted: boolean;
}

export interface SyncEntryStateRow {
  entryId: string;
  remote: RemoteSyncEntryRow | null;
  base: BaseSyncEntryRow;
  local: LocalSyncEntryRow | null;
  dirty: PendingMutationRow | null;
}

export interface CachedSyncBlobRow {
  blobId: string;
  hash: string | null;
  encryptedBytes: Uint8Array;
  cachedAt: number;
  role?: SyncBlobRole;
  refEntryId?: string | null;
}

export type SyncBlobRole = "base" | "remote" | "local-cache";

export type PendingMutationBlockedReason =
  | "file_too_large"
  | "storage_quota_exceeded"
  | "unresolved_rejection"
  // The server rejected the change several times in a row (see push-service.ts).
  | "repeated_rejection";

export interface PendingMutationRow {
  mutationId: string;
  entryId: string;
  op: "upsert" | "delete";
  status?: "pending" | "blocked";
  blockedReason?: PendingMutationBlockedReason | null;
  baseRevision: number;
  baseBlobId?: string | null;
  baseHash?: string | null;
  blobId: string | null;
  hash: string | null;
  encryptedMetadata: string;
  createdAt: number;
  entryType?: "file" | "folder";
  pathToken?: string | null;
}

export interface MarkEntryDirtyOptions {
  requireBaseBlob?: boolean;
}

// Thrown by markEntryDirty/replaceDirtyEntry with requireBaseBlob when the mutation's
// base blob (the 3-way text merge base) is not cached. Callers queuing a local edit
// treat it as non-fatal and queue the change without a merge base.
export class MissingBaseBlobError extends Error {
  constructor(
    readonly entryId: string,
    readonly baseBlobId: string,
  ) {
    super(`Dirty entry ${entryId} requires cached base blob ${baseBlobId}.`);
    this.name = "MissingBaseBlobError";
  }
}

export interface SyncConnection {
  localVaultId: string;
  remoteVaultId: string;
  lastPulledCursor: number;
  initialSyncMode?: "download" | "merge";
  initialSyncComplete?: boolean;
}

export interface SyncProgressCounts {
  completedEntries: number;
  totalEntries: number;
}

export interface DeletedSyncEntryRow {
  entryId: string;
  path: string;
  revision: number;
  deletedAt: number;
  dirty: boolean;
}

export interface SyncStore
  extends SyncConnectionStore,
    SyncRemoteEntryStore,
    SyncLocalEntryStore,
    SyncEntryStore,
    SyncCursorStore,
    SyncMutationStore,
    SyncBlobStore,
    SyncStoreLifecycle {}
