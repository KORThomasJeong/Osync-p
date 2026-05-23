import Dexie, { type Table } from "dexie";

import type { BlobRecord, EntryRecord, MetadataRecord } from "./records";

const DB_NAMESPACE_VERSION = "v1";
const ENTRIES_SCHEMA =
  "&entryId,&remotePathKey,&localPathKey,dirty,pendingStatus,pendingMutationId,[dirty+pendingCreatedAt+entryId],[pendingStatus+pendingCreatedAt+entryId]";

export const METADATA_ID = "sync";
export const MIN_PENDING_CREATED_AT = 0;

export class SyncDexieDatabase extends Dexie {
  metadata!: Table<MetadataRecord, string>;
  entries!: Table<EntryRecord, string>;
  blobs!: Table<BlobRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      metadata: "&id",
      entries: ENTRIES_SCHEMA,
      blobs: "&blobId,hash,role,refEntryId,cachedAt",
    });
    this.version(2).stores({
      metadata: "&id",
      entries: ENTRIES_SCHEMA,
      blobs: "&blobId,hash,role,refEntryId,cachedAt",
    }).upgrade((tx) => {
      return tx.table<MetadataRecord>("metadata").toCollection().modify((record) => {
        if (record.initialSyncComplete === undefined) {
          record.initialSyncComplete = true;
        }
      });
    });
    this.version(3).stores({
      metadata: "&id",
      entries: ENTRIES_SCHEMA,
      blobs: "&blobId,hash,role,refEntryId,cachedAt",
    }).upgrade((tx) => {
      return tx.table<EntryRecord>("entries").toCollection().modify((record) => {
        if (record.entryType === undefined) {
          record.entryType = "file";
        }
      });
    });
    this.version(4).stores({
      metadata: "&id",
      entries: ENTRIES_SCHEMA,
      blobs: "&blobId,hash,role,refEntryId,cachedAt",
    }).upgrade((tx) => {
      return tx.table<EntryRecord>("entries").toCollection().modify((record) => {
        if (record.pendingPathToken === undefined) {
          record.pendingPathToken = null;
        }
      });
    });
  }
}

export function syncStoreDbName(localVaultId: string): string {
  return `osync:sync-store:${DB_NAMESPACE_VERSION}:${localVaultId}`;
}

export const SYNC_STORE_DB_PREFIX = `osync:sync-store:${DB_NAMESPACE_VERSION}:`;

export interface IndexedDbLister {
  listDatabases(): Promise<Array<{ name?: string }>>;
  deleteDatabase(name: string): Promise<void>;
}

export const defaultIndexedDbLister: IndexedDbLister = {
  listDatabases: async () => {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
      return [];
    }
    try {
      return await indexedDB.databases();
    } catch {
      return [];
    }
  },
  deleteDatabase: (name: string) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("delete failed"));
      request.onblocked = () => {
        console.warn(`[osync] orphan IndexedDB blocked, skipping: ${name}`);
        resolve();
      };
    }),
};

export interface OrphanCleanupResult {
  deleted: string[];
  failed: string[];
}

export async function cleanupOrphanSyncStores(
  currentLocalVaultId: string,
  lister: IndexedDbLister = defaultIndexedDbLister,
): Promise<OrphanCleanupResult> {
  const currentName = syncStoreDbName(currentLocalVaultId);
  const deleted: string[] = [];
  const failed: string[] = [];

  const databases = await lister.listDatabases();
  for (const db of databases) {
    const name = db.name;
    if (!name || !name.startsWith(SYNC_STORE_DB_PREFIX)) continue;
    if (name === currentName) continue;

    try {
      await lister.deleteDatabase(name);
      deleted.push(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[osync] failed to delete orphan IndexedDB ${name}: ${message}`);
      failed.push(name);
    }
  }

  return { deleted, failed };
}
