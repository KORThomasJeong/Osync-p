import type {
  CachedSyncBlobRow,
  DeletedSyncEntryRow,
  LocalSyncEntryRow,
  MarkEntryDirtyOptions,
  PendingMutationBlockedReason,
  PendingMutationRow,
  RemoteSyncEntryRow,
  SyncConnection,
  SyncEntryRow,
  SyncEntryStateRow,
  SyncProgressCounts,
} from "./store";

export interface SyncConnectionStore {
  readLocalVaultId(): Promise<string>;
  readSyncConnection(): Promise<SyncConnection | null>;
  writeSyncConnection(connection: SyncConnection): Promise<void>;
}

export interface SyncRemoteEntryStore {
  ensureEntry(entryId: string): Promise<void>;
  getRemoteStateById(entryId: string): Promise<RemoteSyncEntryRow | null>;
  getRemoteStateByPath(path: string): Promise<RemoteSyncEntryRow | null>;
  listRemoteStates(): Promise<RemoteSyncEntryRow[]>;
  applyRemoteState(entry: RemoteSyncEntryRow): Promise<void>;
  clearRemoteState(entryId: string): Promise<void>;
}

export interface SyncLocalEntryStore {
  getLocalStateById(entryId: string): Promise<LocalSyncEntryRow | null>;
  getLocalStateByPath(path: string): Promise<LocalSyncEntryRow | null>;
  listLocalStates(): Promise<LocalSyncEntryRow[]>;
  countLocalStates(): Promise<number>;
  applyLocalState(entry: LocalSyncEntryRow): Promise<void>;
  clearLocalState(entryId: string): Promise<void>;
  bulkApply(operations: readonly BulkEntryApplyOp[]): Promise<void>;
}

export type BulkEntryApplyOp =
  | { kind: "upsert"; entry: SyncEntryRow }
  | { kind: "applyRemote"; entry: RemoteSyncEntryRow };

export interface SyncEntryStore {
  getEntryById(entryId: string): Promise<SyncEntryRow | null>;
  getEntryByPath(path: string): Promise<SyncEntryRow | null>;
  getEntryStateById(entryId: string): Promise<SyncEntryStateRow | null>;
  listEntries(): Promise<SyncEntryRow[]>;
  listDeletedEntries(): Promise<DeletedSyncEntryRow[]>;
  countSyncProgress(): Promise<SyncProgressCounts>;
  getOrCreateEntryId(path: string): Promise<string>;
  upsertEntry(entry: SyncEntryRow): Promise<void>;
  deleteEntry(entryId: string): Promise<void>;
}

export interface SyncCursorStore {
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
}

export interface SyncMutationStore {
  markEntryDirty(
    mutation: PendingMutationRow,
    options?: MarkEntryDirtyOptions,
  ): Promise<void>;
  replaceDirtyEntry(
    mutation: PendingMutationRow,
    options?: MarkEntryDirtyOptions,
  ): Promise<void>;
  getDirtyEntryMutation(entryId: string): Promise<PendingMutationRow | null>;
  listDirtyEntries(limit?: number): Promise<PendingMutationRow[]>;
  updateDirtyEntry(mutation: PendingMutationRow): Promise<void>;
  unblockDirtyEntriesByReason(reason: PendingMutationBlockedReason): Promise<void>;
  clearDirtyEntryByMutationId(mutationId: string): Promise<void>;
  markEntryClean(entryId: string): Promise<void>;
}

export interface SyncBlobStore {
  getBlob(blobId: string): Promise<CachedSyncBlobRow | null>;
  putBlob(blob: CachedSyncBlobRow): Promise<void>;
}

export interface SyncStoreLifecycle {
  flush(): Promise<void>;
  close(): Promise<void>;
  setCorruptionListener(listener: SyncStoreCorruptionListener | null): void;
}

export interface SyncStoreCorruptionEvent {
  kind: "constraint_error";
  entryId: string;
  message: string;
}

export type SyncStoreCorruptionListener = (event: SyncStoreCorruptionEvent) => void;
