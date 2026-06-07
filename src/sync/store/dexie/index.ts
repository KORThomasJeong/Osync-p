import Dexie from "dexie";
import type { Plugin } from "obsidian";

import { METADATA_ID, SyncDexieDatabase, syncStoreDbName } from "./database";
import {
  clearLocalVaultId,
  getOrCreateLocalVaultId,
  readLocalVaultId,
} from "./local-vault";
import { toSyncConnection } from "./mappers";
import { DexieSyncStore } from "./store";
import type { SyncConnection, SyncStore } from "../store";

export async function createDexieSyncStore(plugin: Plugin): Promise<SyncStore> {
  const store = new DexieSyncStore(plugin, getOrCreateLocalVaultId(plugin));
  await store.initialize();
  return store;
}

export async function clearDexieSyncStore(
  plugin: Plugin,
  opts?: { preserveLocalVaultId?: boolean },
): Promise<void> {
  const localVaultId = readLocalVaultId(plugin);
  if (localVaultId) {
    // Best-effort: clear table contents in place so even if the DB drop fails
    // (e.g., on mobile Obsidian where IndexedDB can throw DOMException
    // "operation-specific reason"), the user-visible state still reflects a
    // reset.
    try {
      const db = new SyncDexieDatabase(syncStoreDbName(localVaultId));
      try {
        await Promise.all([
          db.metadata.clear(),
          db.entries.clear(),
          db.blobs.clear(),
        ]);
      } finally {
        db.close();
      }
    } catch {
      // Couldn't open or clear in place — fall through to delete attempt.
    }
    // Attempt to drop the DB to also reclaim storage and reset schema. If
    // this throws (mobile IndexedDB sometimes does), suppress: orphaning the
    // DB is harmless because the next bootstrap either reuses the preserved id
    // (re-creating an empty DB under the same name) or, when the id is cleared
    // below, creates a fresh DB with a new id.
    try {
      await Dexie.delete(syncStoreDbName(localVaultId));
    } catch {
      // Mobile fallback path — tables already cleared above (best-effort).
    }
  }
  // Corruption recovery and the user "Reset local sync state" path preserve the
  // localVaultId so the device keeps its stable identity (sync token binding,
  // server-side device record). Explicit unpair paths omit the option to
  // regenerate a fresh id on the next bootstrap.
  if (!opts?.preserveLocalVaultId) {
    clearLocalVaultId(plugin);
  }
}

export async function readDexieSyncStoreConnection(
  plugin: Plugin,
): Promise<SyncConnection | null> {
  const localVaultId = readLocalVaultId(plugin);
  if (!localVaultId) {
    return null;
  }

  const db = new SyncDexieDatabase(syncStoreDbName(localVaultId));
  try {
    const metadata = await db.metadata.get(METADATA_ID);
    return toSyncConnection(localVaultId, metadata);
  } finally {
    db.close();
  }
}
