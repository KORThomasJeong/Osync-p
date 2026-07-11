import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../core/content";
import { VaultKeyCryptoService } from "../core/crypto-service";
import { createDexieSyncStore } from "../store/dexie";
import { toPathKey } from "../store/dexie/path-key";
import type { SyncStoreCorruptionEvent } from "../store/ports";
import { SyncLocalReconcileService } from "./local-reconcile-service";
import { createTestPlugin } from "../../test-support/test-plugin";
import {
  localFile,
  putTestBaseBlob,
  TEST_VAULT_KEY,
} from "./__tests__/local-reconcile-service/helpers";

// End-to-end reproduction of the macOS NFD/NFC sync bug at the store + reconcile layer.
//
// macOS returns Korean filenames decomposed (NFD: "ᄀ + ㅏ"), while the server derives its
// pathToken — and the manifest path it ships back — from the composed form (NFC: "가"). Both
// strings name the SAME logical file, but a raw (un-normalized) comparison treats them as two
// files. Historically that meant: a remote NFC entry + a local NFD scan of the same file each
// claimed a row, the &localPathKey / &remotePathKey unique indexes collided once normalized,
// Dexie threw ConstraintError, the corruption listener tripped, the store was reset, and the
// localVaultId regenerated — breaking sync on every cycle.
//
// This test drives the REAL DexieSyncStore (over fake-indexeddb, same harness as dexie.test.ts)
// so the genuine unique indexes, normalizeEntryRecord, and resolvePathKeyCollision recovery are
// all exercised — the InMemorySyncStore test double has no index and would mask the bug.
//
// Same NFC ("가") vs NFD ("ᄀ + ㅏ") fixture convention as merge-entries.test.ts.
const NFC_PATH = "노트/가.md";
const NFD_PATH = "노트/가.md".normalize("NFD");

const BODY = encodeUtf8("동기화 본문");

function collectCorruption(
  store: { setCorruptionListener: (l: ((e: SyncStoreCorruptionEvent) => void) | null) => void },
): SyncStoreCorruptionEvent[] {
  const events: SyncStoreCorruptionEvent[] = [];
  store.setCorruptionListener((event) => events.push(event));
  return events;
}

describe("NFC reconcile integration (macOS NFD/NFC)", () => {
  it("resolves a remote NFC entry and a local NFD scan to a single entry without corruption", async () => {
    const hash = await hashBytes(BODY);
    const store = await createDexieSyncStore(createTestPlugin());
    const corruption = collectCorruption(store);

    // Server pushes the file under its composed (NFC) path. This writes the row's
    // remotePathKey = NFC and binds entryId "entry-remote". A markdown file with a remote
    // blob requires its base blob cached so the reconcile upsert can be queued.
    await store.applyRemoteState({
      entryId: "entry-remote",
      path: NFC_PATH,
      revision: 1,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 100,
    });
    await putTestBaseBlob(store, { blobId: "blob-1", hash, bytes: BODY });

    // macOS scans the very same file and hands the reconcile service the decomposed (NFD)
    // path. reconcileOnce resolves it through getLocalStateByPath / getEntryByPath /
    // getOrCreateEntryId, all of which key by toPathKey (NFC) — so it must land on the
    // existing remote entry rather than minting a brand new entryId.
    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [localFile(NFD_PATH, BODY)];
        },
        listFolders: () => [],
      },
    });

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });

    // No ConstraintError surfaced through the corruption listener: the NFD scan reused the
    // remote NFC entry instead of producing a colliding duplicate.
    expect(corruption).toEqual([]);

    // Exactly one entry survives — no duplicate entryId proliferation.
    const entries = await store.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entryId).toBe("entry-remote");

    // The local side is tracked under the same entry; localPath stays in the OS-returned
    // NFD form (used for real file I/O), never rewritten to NFC.
    const local = await store.getLocalStateById("entry-remote");
    expect(local?.path).toBe(NFD_PATH);

    // Both NFD and NFC lookups land on the same single entry (keys are NFC).
    expect((await store.getEntryByPath(NFD_PATH))?.entryId).toBe("entry-remote");
    expect((await store.getEntryByPath(NFC_PATH))?.entryId).toBe("entry-remote");

    await store.close();
  });

  it("auto-merges a colliding NFD-vs-NFC pair into one canonical NFC-keyed entry", async () => {
    // Reproduces the historical corruption directly on the &localPathKey unique index: a
    // synced entry whose localPath is the composed (NFC) form, plus a stale second entry under
    // a DIFFERENT entryId carrying the decomposed (NFD) twin of the SAME file (i.e. it never
    // got NFC-normalized). Both rows normalize to the identical NFC localPathKey, so persisting
    // the second one raises Dexie ConstraintError. putEntry must auto-recover via
    // resolvePathKeyCollision + normalizeEntryRecord — folding them onto a single canonical
    // entry with NFC keys — WITHOUT firing the corruption listener or throwing.
    const hash = await hashBytes(BODY);
    const store = await createDexieSyncStore(createTestPlugin());
    const corruption = collectCorruption(store);

    // A fully-synced entry (remote + local) at the NFC path => localPathKey = NFC.
    await store.upsertEntry({
      entryId: "entry-synced",
      path: NFC_PATH,
      revision: 2,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 100,
      localMtime: 10,
      localSize: BODY.byteLength,
    });

    // A stale local-only entry under a different entryId carrying the NFD twin. Its
    // localPathKey normalizes to the same NFC key as entry-synced's — the index collision the
    // macOS bug produced. Identical content (same hash) means the loser folds into the
    // canonical rather than spawning a .sync-conflict copy.
    await store.applyLocalState({
      entryId: "entry-local-nfd",
      path: NFD_PATH,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 90,
      localMtime: 10,
      localSize: BODY.byteLength,
    });

    // The recovery is invisible to callers: no throw, no corruption event.
    expect(corruption).toEqual([]);

    // The two rows folded into a single live entry — no duplicate entryId proliferation.
    const live = (await store.listEntries()).filter((entry) => !entry.deleted);
    expect(live).toHaveLength(1);

    const survivor = live[0]!;
    // The canonical winner keeps the remote-backed (synced) entry; pickCanonical favours
    // remoteKnown rows over the local-only NFD loser.
    expect(survivor.entryId).toBe("entry-synced");

    // Stored keys are NFC; both NFD and NFC lookups resolve to the one survivor.
    expect((await store.getEntryByPath(NFC_PATH))?.entryId).toBe("entry-synced");
    expect((await store.getEntryByPath(NFD_PATH))?.entryId).toBe("entry-synced");
    expect(toPathKey(NFD_PATH)).toBe(NFC_PATH);

    await store.close();
  });

  it("does not queue a ghost delete when a synced entry's NFC localPath is rescanned as NFD", async () => {
    // A fully-synced file whose stored localPath is composed (NFC) — as the pull applier
    // writes it. macOS then rescans the very same file decomposed (NFD). The reconcile
    // delete loop compares the scan set against each entry's path; a raw comparison sees the
    // NFC entry as "missing from disk" and queues a delete for a file that is right there,
    // tombstoning it on the server and churning it back on the next pull.
    const hash = await hashBytes(BODY);
    const store = await createDexieSyncStore(createTestPlugin());
    const corruption = collectCorruption(store);

    await store.upsertEntry({
      entryId: "entry-synced",
      path: NFC_PATH,
      revision: 3,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 100,
      localMtime: 10,
      localSize: BODY.byteLength,
    });
    await putTestBaseBlob(store, { blobId: "blob-1", hash, bytes: BODY });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [localFile(NFD_PATH, BODY)];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce();

    // The NFD scan matches the NFC entry — no ghost delete.
    expect(result.filesQueuedForDelete).toBe(0);
    const local = await store.getLocalStateById("entry-synced");
    expect(local?.deleted).toBe(false);
    expect(corruption).toEqual([]);

    await store.close();
  });
});
