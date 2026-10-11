import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncEventRecorder } from "../../event-recorder";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { decryptPendingMetadata, localFile, TEST_VAULT_KEY } from "./helpers";

// A synced .md entry normally has its base blob cached for the 3-way text merge. When
// it is not (pulled before caching existed, adopted without a download, cache cleared),
// queuing an edit of that file must still work: the change goes out without a merge
// base and an eventual conflict falls back to a conflict copy. It must never abort the
// scan of every other file.
describe("missing cached base blob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function arrangeSyncedNoteWithoutBaseBlob() {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Notes/edited.md",
      revision: 3,
      blobId: "blob-base-not-cached",
      hash: await hashBytes(encodeUtf8("synced body")),
      deleted: false,
      updatedAt: 1,
      localMtime: 1,
      localSize: 1,
    });
    return store;
  }

  it("queues the dirty note without a merge base and still queues every other file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await arrangeSyncedNoteWithoutBaseBlob();
    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Notes/a-new.md", encodeUtf8("new a")),
            localFile("Notes/edited.md", encodeUtf8("edited locally")),
            localFile("Notes/z-new.md", encodeUtf8("new z")),
          ];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 3,
      filesQueuedForUpsert: 3,
      filesQueuedForDelete: 0,
    });
    const edited = await store.getDirtyEntryMutation("entry-note");
    expect(edited).toMatchObject({
      op: "upsert",
      baseRevision: 3,
      hash: await hashBytes(encodeUtf8("edited locally")),
    });
    await expect(decryptPendingMetadata(edited)).resolves.toMatchObject({
      path: "Notes/edited.md",
    });
    expect((await store.listDirtyEntries()).length).toBe(3);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("base blob"))).toHaveLength(1);
    await store.close();
  });

  it("skips a file it cannot read, queues every other file, and never deletes it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await arrangeSyncedNoteWithoutBaseBlob();
    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Notes/a-new.md", encodeUtf8("new a")),
            {
              // Known entry, changed on disk (mtime differs) but locked right now.
              path: "Notes/edited.md",
              mtime: 99,
              size: 5,
              async readBytes(): Promise<Uint8Array> {
                throw new Error("EBUSY: resource busy or locked");
              },
            },
            localFile("Notes/z-new.md", encodeUtf8("new z")),
          ];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 3,
      filesQueuedForUpsert: 2,
      filesQueuedForDelete: 0,
    });
    expect(await store.getDirtyEntryMutation("entry-note")).toBeNull();
    expect((await store.listDirtyEntries()).length).toBe(2);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("could not read"))).toHaveLength(1);
    await store.close();
  });

  it("never queues a delete for a file under a path the scanner could not list", async () => {
    const store = await arrangeSyncedNoteWithoutBaseBlob();
    await store.upsertEntry({
      entryId: "entry-config",
      path: ".obsidian/plugins/x/data.json",
      revision: 2,
      blobId: "blob-config",
      hash: "config-hash",
      deleted: false,
      updatedAt: 1,
    });
    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [localFile("Notes/edited.md", encodeUtf8("synced body"))];
        },
        listFolders: () => [],
        listUnscannedPaths: () => [".obsidian/plugins"],
      },
    });

    const result = await service.reconcileOnce();

    expect(result.filesQueuedForDelete).toBe(0);
    expect(await store.getDirtyEntryMutation("entry-config")).toBeNull();
    await store.close();
  });

  it("records a vault edit of the note without a merge base instead of failing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await arrangeSyncedNoteWithoutBaseBlob();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    });

    await expect(
      recorder.recordUpsert("Notes/edited.md", encodeUtf8("edited in the editor")),
    ).resolves.toBe(true);

    expect(await store.getDirtyEntryMutation("entry-note")).toMatchObject({
      op: "upsert",
      baseRevision: 3,
      hash: await hashBytes(encodeUtf8("edited in the editor")),
    });
    await store.close();
  });
});
