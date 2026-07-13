import type {
  OsyncConflictCleanupResult,
  OsyncConflictCopy,
  OsyncDeletedFile,
  OsyncFileRules,
  OsyncStorageStatus,
  OsyncSyncProgress,
  OsyncSyncState,
} from "../plugin/view-models";

/**
 * Sync-domain surface for the settings UI.
 *
 * Covers everything the user sees about ongoing synchronization: live state,
 * progress, storage usage, file-inclusion rules, and the deleted-files
 * recovery view. Auth and vault lifecycle live on their own facades.
 */
export interface OsyncSyncFacade {
  getSyncState(): OsyncSyncState;
  getSyncStatusLabel(): string;
  getSyncPercent(): number;
  getSyncProgress(): OsyncSyncProgress;
  getStorageStatus(): OsyncStorageStatus | null;
  watchStorageStatus(): void;
  unwatchStorageStatus(): void;
  getSyncFileRules(): OsyncFileRules;
  updateSyncFileRule<K extends keyof OsyncFileRules>(
    key: K,
    value: OsyncFileRules[K],
  ): Promise<void>;
  updateExcludedFolders(paths: string[]): Promise<void>;
  listSelectableExcludedFolderPaths(): string[];
  listDeletedFiles(): Promise<OsyncDeletedFile[]>;
  restoreDeletedFiles(entryIds: string[]): Promise<{ restored: number; failed: number }>;
  listConflictCopies(): Promise<OsyncConflictCopy[]>;
  deleteConflictCopies(
    paths: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<OsyncConflictCleanupResult>;
  resetLocalSyncStateInPlace(): Promise<void>;
  purgeExcludedFoldersFromServer(): Promise<void>;
}
