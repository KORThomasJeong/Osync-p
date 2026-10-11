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

// How long a database delete may stay blocked (another connection still open) before
// the reset moves on and relies on the in-place clear and the check below.
const DELETE_TIMEOUT_MS = 5_000;

export interface ClearSyncStoreResult {
  // The store under the kept localVaultId is confirmed empty (or there was none).
  // False only when it could not be confirmed; a new localVaultId was then issued so
  // the next store starts empty regardless.
  verified: boolean;
}

export async function clearDexieSyncStore(
  plugin: Plugin,
  opts?: { preserveLocalVaultId?: boolean; deleteTimeoutMs?: number },
): Promise<ClearSyncStoreResult> {
  const localVaultId = readLocalVaultId(plugin);
  let verified = true;
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
    const timeoutMs = opts?.deleteTimeoutMs ?? DELETE_TIMEOUT_MS;
    // A failed or still-blocked delete is the mobile fallback path: the tables were
    // already cleared above (best-effort), and the check below decides.
    await settleWithin(
      Dexie.delete(syncStoreDbName(localVaultId)).then(
        () => true,
        () => false,
      ),
      timeoutMs,
      false,
    );
    // An open queued behind a still-blocked delete waits too; not knowing counts as
    // not cleared.
    verified = await settleWithin(isSyncStoreEmpty(localVaultId), timeoutMs, false);
    if (!verified && opts?.preserveLocalVaultId) {
      // Neither the clear nor the delete took (seen on iOS once its IndexedDB
      // connection broke). Reusing the id would reopen the old cursor and queue, so
      // issue a new one; the old database is an orphan the cleanup removes later.
      console.warn("[osync] reset: old sync store still has data; issuing a new local vault id");
      clearLocalVaultId(plugin);
    }
  }
  // Corruption recovery and the user "Reset local sync state" path preserve the
  // localVaultId so the device keeps its stable identity (sync token binding,
  // server-side device record). Explicit unpair paths omit the option to
  // regenerate a fresh id on the next bootstrap.
  if (!opts?.preserveLocalVaultId) {
    clearLocalVaultId(plugin);
  }
  return { verified };
}

// True when the store under this id holds no cursor and no entries (a deleted
// database reopens empty). False when it still has data or cannot be read.
export async function isSyncStoreEmpty(localVaultId: string): Promise<boolean> {
  const db = new SyncDexieDatabase(syncStoreDbName(localVaultId));
  try {
    const metadata = await db.metadata.get(METADATA_ID);
    const entries = await db.entries.count();
    return entries === 0 && (metadata?.lastPulledCursor ?? 0) === 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

// The work's result, or the fallback once timeoutMs passes first.
async function settleWithin<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
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
