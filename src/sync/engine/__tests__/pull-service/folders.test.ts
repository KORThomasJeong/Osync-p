import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { SyncPullService } from "../../pull-service";
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
});

