export interface OsyncFileRules {
  includeImages: boolean;
  includeAudio: boolean;
  includeVideos: boolean;
  includePdf: boolean;
  includeOtherFiles: boolean;
  includeObsidianConfig: boolean;
  excludedFolders: string[];
}

export type OsyncSyncState =
  | "not_ready"
  | "syncing"
  | "reconnecting"
  | "up_to_date"
  | "attention_needed";

export interface OsyncSyncProgress {
  completedEntries: number;
  totalEntries: number;
}

export interface OsyncStorageStatus {
  storageUsedBytes: number;
  storageLimitBytes: number;
}

export interface OsyncDeletedFile {
  entryId: string;
  path: string;
  revision: number;
  deletedAt: number;
  dirty: boolean;
}

export interface OsyncEntryVersionCursor {
  capturedAt: number;
  versionId: string;
}

export interface OsyncEntryVersion {
  versionId: string;
  sourceRevision: number;
  op: "upsert" | "delete";
  hasBlob: boolean;
  reason: "auto" | "before_delete" | "before_restore" | "manual";
  capturedAt: number;
}

export interface OsyncEntryVersionsPage {
  path: string;
  dirty: boolean;
  versions: OsyncEntryVersion[];
  hasMore: boolean;
  nextBefore: OsyncEntryVersionCursor | null;
}

export interface OsyncConflictCopy {
  path: string;
  size: number;
  mtime: number;
}

export interface OsyncConflictCleanupResult {
  successCount: number;
  failures: Array<{ path: string; error: string }>;
}
