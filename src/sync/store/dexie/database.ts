import Dexie, { type Table } from "dexie";

import { resolvePathKeyCollision } from "./merge-entries";
import { toPathKey } from "./path-key";
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
    this.version(5).stores({
      metadata: "&id",
      entries: ENTRIES_SCHEMA,
      blobs: "&blobId,hash,role,refEntryId,cachedAt",
    }).upgrade(async (tx) => {
      // Raw (NFD on macOS) path keys diverged from the NFC pathToken the server derives,
      // so &localPathKey / &remotePathKey could carry NFD values that collide once
      // normalized to NFC. Recompute every key in NFC, merge the records that now share a
      // key, and rewrite the table atomically so the unique indexes never go transient.
      const all = await tx.table<EntryRecord>("entries").toArray();

      // Union-find over the NFC keys. A record exposes its NFC localPathKey and/or
      // remotePathKey (same gating normalizeEntryRecord uses), and a record whose two keys
      // differ joins both buckets — unioning them so it is resolved exactly once.
      const parent = new Map<number, number>();
      const find = (x: number): number => {
        let root = x;
        while (parent.get(root) !== root) {
          root = parent.get(root)!;
        }
        let cursor = x;
        while (parent.get(cursor) !== root) {
          const next = parent.get(cursor)!;
          parent.set(cursor, root);
          cursor = next;
        }
        return root;
      };
      const union = (a: number, b: number): void => {
        parent.set(find(a), find(b));
      };

      const keyToIndex = new Map<string, number>();
      for (let i = 0; i < all.length; i += 1) {
        parent.set(i, i);
      }
      for (let i = 0; i < all.length; i += 1) {
        for (const key of nfcKeysOf(all[i])) {
          const seen = keyToIndex.get(key);
          if (seen === undefined) {
            keyToIndex.set(key, i);
          } else {
            union(seen, i);
          }
        }
      }

      // Bucket each record under its union-find root, then resolve every group (singletons
      // included, so their keys are normalized to NFC even when nothing collides).
      const groups = new Map<number, EntryRecord[]>();
      for (let i = 0; i < all.length; i += 1) {
        const root = find(i);
        const bucket = groups.get(root);
        if (bucket) {
          bucket.push(all[i]);
        } else {
          groups.set(root, [all[i]]);
        }
      }

      const resolved: EntryRecord[] = [];
      for (const group of groups.values()) {
        resolved.push(...resolvePathKeyCollision(group));
      }

      // Clear before bulkPut so a record that adopts another's former NFC key never
      // violates the unique index mid-migration.
      await tx.table<EntryRecord>("entries").clear();
      await tx.table<EntryRecord>("entries").bulkPut(resolved);
    });
  }
}

// NFC comparison keys for a record, namespaced by side so a local key and a remote key
// with the same string don't accidentally merge unrelated records. Mirrors the
// known/path/!deleted gating in normalizeEntryRecord so grouping matches the stored index.
function nfcKeysOf(record: EntryRecord): string[] {
  const keys: string[] = [];
  if (record.localKnown && record.localPath && !record.localDeleted) {
    keys.push(`local:${toPathKey(record.localPath)}`);
  }
  if (record.remoteKnown && record.remotePath && !record.remoteDeleted) {
    keys.push(`remote:${toPathKey(record.remotePath)}`);
  }
  return keys;
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
  ownedLocalVaultIds: readonly string[],
  lister: IndexedDbLister = defaultIndexedDbLister,
): Promise<OrphanCleanupResult> {
  const currentName = syncStoreDbName(currentLocalVaultId);
  const deleted: string[] = [];
  const failed: string[] = [];

  // On Obsidian desktop every open vault shares one IndexedDB origin, so the
  // orphan list contains other vaults' sync stores. Only ever delete stores this
  // vault has previously owned — never a store belonging to another vault.
  const deletableNames = new Set(
    ownedLocalVaultIds
      .map((id) => syncStoreDbName(id))
      .filter((name) => name !== currentName),
  );

  const databases = await lister.listDatabases();
  for (const db of databases) {
    const name = db.name;
    if (!name || !name.startsWith(SYNC_STORE_DB_PREFIX)) continue;
    if (name === currentName) continue;
    if (!deletableNames.has(name)) continue;

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
