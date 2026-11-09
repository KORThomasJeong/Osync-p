import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { SyncPullService } from "../../pull-service";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import {
  createCommit,
  createEventGate,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptFolderMetadata,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPullService folder entries", () => {
  it("creates folder when receiving a non-deleted folder entry", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter();
    const suppressionCalls: string[][] = [];

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "folder-1",
              revision: 1,
              blobId: null,
              entryType: "folder",
              encryptedMetadata: await encryptFolderMetadata({
                entryId: "folder-1",
                revision: 1,
                path: "MyFolder",
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({ blobs: {} });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
      onProgress: ignoreProgress,
    });

    const result = await service.pullOnce(session);

    expect(result.cursor).toBe(1);
    expect(result.entriesApplied).toBe(1);
    expect(result.filesDeleted).toBe(0);
    expect(result.conflictsCreated).toBe(0);
    expect(adapter.directories.has("MyFolder")).toBe(true);
    expect(adapter.files.size).toBe(0);

    await store.close();
  });

  it("does not delete a non-empty folder when receiving a deleted folder entry", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter(
      { "MyFolder/note.md": "still here" },
      ["MyFolder"],
    );
    const suppressionCalls: string[][] = [];

    await store.upsertEntry({
      entryId: "folder-1",
      path: "MyFolder",
      revision: 1,
      blobId: null,
      hash: null,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
      entryType: "folder",
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "folder-1",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              blobId: null,
              entryType: "folder",
              encryptedMetadata: await encryptFolderMetadata({
                entryId: "folder-1",
                revision: 2,
                deleted: true,
                path: "MyFolder",
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({ blobs: {} });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
      onProgress: ignoreProgress,
    });

    const result = await service.pullOnce(session);

    expect(result.cursor).toBe(2);
    expect(adapter.directories.has("MyFolder")).toBe(true);
    expect(adapter.text("MyFolder/note.md")).toBe("still here");

    await store.close();
  });

  it("safe-deletes an empty folder when receiving a deleted folder entry", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter({}, ["MyFolder"]);
    const suppressionCalls: string[][] = [];

    await store.upsertEntry({
      entryId: "folder-1",
      path: "MyFolder",
      revision: 1,
      blobId: null,
      hash: null,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
      entryType: "folder",
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "folder-1",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              blobId: null,
              entryType: "folder",
              encryptedMetadata: await encryptFolderMetadata({
                entryId: "folder-1",
                revision: 2,
                deleted: true,
                path: "MyFolder",
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({ blobs: {} });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
      onProgress: ignoreProgress,
    });

    const result = await service.pullOnce(session);

    expect(result.cursor).toBe(2);
    expect(adapter.directories.has("MyFolder")).toBe(false);
    expect(adapter.files.size).toBe(0);

    await store.close();
  });

  // Deletes arrive in apply windows. When a parent folder's delete lands in an earlier
  // window than its subfolder's, the parent is not empty yet and stays; it must be
  // removed once the subfolder goes, or the next scan pushes it back as a new folder.
  it("removes a deleted parent folder once its deleted subfolder is removed in a later window", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter({}, ["Old", "Old/Sub"]);

    for (const [entryId, path] of [
      ["folder-parent", "Old"],
      ["folder-child", "Old/Sub"],
    ]) {
      await store.upsertEntry({
        entryId,
        path,
        revision: 1,
        blobId: null,
        hash: null,
        deleted: false,
        updatedAt: 1,
        localMtime: null,
        localSize: null,
        entryType: "folder",
      });
    }

    const deleteCommit = async (cursor: number, entryId: string, path: string) =>
      createCommit({
        cursor,
        entryId,
        op: "delete",
        revision: 2,
        baseRevision: 1,
        blobId: null,
        entryType: "folder",
        encryptedMetadata: await encryptFolderMetadata({
          entryId,
          revision: 2,
          deleted: true,
          path,
        }),
      });

    const session = createRealtimeSession({
      pages: [
        { cursor: 2, hasMore: true, commits: [await deleteCommit(2, "folder-parent", "Old")] },
        { cursor: 3, hasMore: false, commits: [await deleteCommit(3, "folder-child", "Old/Sub")] },
      ],
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate([]),
      pullClient: createPullClient({ blobs: {} }),
      onProgress: ignoreProgress,
      applyWindowSize: 1,
    });

    await service.pullOnce(session);

    expect(adapter.directories.has("Old/Sub")).toBe(false);
    expect(adapter.directories.has("Old")).toBe(false);

    await store.close();
  });

  // A folder deleted remotely but still holding files this device does not sync
  // (another extension, OS leftovers) stays on disk. The next scan must not push it
  // back as a new folder, and removing it later must not send a second delete.
  it("does not re-create a remotely deleted folder that could not be removed locally", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter({ "Old/script.py": "unsynced" }, ["Old"]);

    await store.upsertEntry({
      entryId: "folder-old",
      path: "Old",
      revision: 1,
      blobId: null,
      hash: null,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
      entryType: "folder",
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "folder-old",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              blobId: null,
              entryType: "folder",
              encryptedMetadata: await encryptFolderMetadata({
                entryId: "folder-old",
                revision: 2,
                deleted: true,
                path: "Old",
              }),
            }),
          ],
        },
      ],
    });

    await new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate([]),
      pullClient: createPullClient({ blobs: {} }),
      onProgress: ignoreProgress,
    }).pullOnce(session);

    expect(adapter.directories.has("Old")).toBe(true);

    const reconcile = (folders: string[]) =>
      new SyncLocalReconcileService({
        getSyncStore: () => store,
        crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
        shouldSyncPath: (path) => !path.endsWith(".py"),
        scanner: {
          async listFiles() {
            return [];
          },
          listFolders: () => folders,
        },
      }).reconcileOnce();

    await reconcile(["Old"]);
    expect(await store.listDirtyEntries()).toEqual([]);

    await reconcile([]);
    expect(await store.listDirtyEntries()).toEqual([]);

    await store.close();
  });
  it("drops a local pending folder create when the server already has that folder under another entry", async () => {
    // A fresh device: the pull wrote a file under "Projects/app" before the folder's own
    // entry arrived, so the folder event recorded a local create under a new entry ID.
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter({}, ["Projects/app"]);

    await store.applyLocalState({
      entryId: "local-folder",
      path: "Projects/app",
      blobId: null,
      hash: null,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
      entryType: "folder",
    });
    await store.markEntryDirty({
      mutationId: "mutation-local-folder",
      entryId: "local-folder",
      op: "upsert",
      baseRevision: 0,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptFolderMetadata({
        entryId: "local-folder",
        revision: 1,
        path: "Projects/app",
      }),
      createdAt: 2,
      entryType: "folder",
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "remote-folder",
              revision: 1,
              blobId: null,
              entryType: "folder",
              encryptedMetadata: await encryptFolderMetadata({
                entryId: "remote-folder",
                revision: 1,
                path: "Projects/app",
              }),
            }),
          ],
        },
      ],
    });
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      pullClient: createPullClient({ blobs: {} }),
      onProgress: ignoreProgress,
    });

    await service.pullOnce(session);

    // Pushing the local create would be rejected forever (its entry is not on the server).
    expect(await store.listDirtyEntries()).toEqual([]);
    expect((await store.getEntryByPath("Projects/app"))?.entryId).toBe("remote-folder");
    expect(adapter.directories.has("Projects/app")).toBe(true);

    await store.close();
  });
  it("records a folder the server already has instead of queueing a colliding create", async () => {
    // Only the remote side is known (the pull recorded it without a local row); the
    // folder exists on disk. A create under a new entry ID would be rejected by the
    // server as a path collision, dropped, and queued again on every scan.
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    await store.applyRemoteState({
      entryId: "remote-folder",
      path: "Projects/app",
      revision: 1,
      blobId: null,
      hash: null,
      deleted: false,
      updatedAt: 1,
      entryType: "folder",
    });

    await new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [];
        },
        listFolders: () => ["Projects/app"],
      },
    }).reconcileOnce();

    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getLocalStateById("remote-folder")).toMatchObject({
      path: "Projects/app",
      deleted: false,
    });

    await store.close();
  });
  it("does not delete a file that is missing from the vault listing but still on disk", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    await store.upsertEntry({
      entryId: "note",
      path: "Notes/a.md",
      revision: 1,
      blobId: "blob-a",
      hash: "hash-a",
      deleted: false,
      updatedAt: 1,
      localMtime: 1,
      localSize: 1,
    });

    const reconcile = (onDisk: boolean) =>
      new SyncLocalReconcileService({
        getSyncStore: () => store,
        crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
        shouldSyncPath: () => true,
        scanner: {
          async listFiles() {
            return [];
          },
          listFolders: () => [],
          exists: async () => onDisk,
        },
      }).reconcileOnce({ allowMassDelete: true });

    await reconcile(true);
    expect(await store.listDirtyEntries()).toEqual([]);

    await reconcile(false);
    expect(await store.listDirtyEntries()).toMatchObject([{ entryId: "note", op: "delete" }]);

    await store.close();
  });
});

