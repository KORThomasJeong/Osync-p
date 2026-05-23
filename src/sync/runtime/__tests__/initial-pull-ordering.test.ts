import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "../../core/content";
import { VaultKeyCryptoService } from "../../core/crypto-service";
import {
  createCommit,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "../../engine/__tests__/pull-service/helpers";
import { SyncLocalReconcileService } from "../../engine/local-reconcile-service";
import { SyncPullService } from "../../engine/pull-service";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../test-support/test-plugin";
import { writeStoredSyncConnection } from "../../store/connection";

describe("Pull-First-Then-Reconcile ordering", () => {
  it("adopts remote entryId when fresh device's disk has matching paths", async () => {
    const remoteContent = "hello";
    const remoteHash = await hashText(remoteContent);
    const { store, runPullThenReconcile } = await arrangeFreshDevice({
      diskFiles: { "notes/hello.md": remoteContent },
      remoteEntries: [
        {
          entryId: "remote-1",
          path: "notes/hello.md",
          revision: 1,
          blobId: "blob-remote-1",
          hash: remoteHash,
          content: remoteContent,
        },
      ],
    });

    const result = await runPullThenReconcile();

    expect(result.reconcile.filesQueuedForUpsert).toBe(0);
    expect(result.reconcile.filesQueuedForDelete).toBe(0);
    expect(await store.listDirtyEntries()).toHaveLength(0);

    const entry = await store.getEntryByPath("notes/hello.md");
    expect(entry?.entryId).toBe("remote-1");
    expect(entry?.hash).toBe(remoteHash);
    await store.close();
  });

  it("does not push duplicate entries when disk content differs from remote", async () => {
    const remoteHash = await hashText("REMOTE");
    const { store, adapter, runPullThenReconcile } = await arrangeFreshDevice({
      diskFiles: { "notes/hello.md": "LOCAL" },
      remoteEntries: [
        {
          entryId: "remote-1",
          path: "notes/hello.md",
          revision: 1,
          blobId: "blob-remote-1",
          hash: remoteHash,
          content: "REMOTE",
        },
      ],
    });

    await runPullThenReconcile();

    const entries = await store.listEntries();
    const matching = entries.filter((entry) => entry.path === "notes/hello.md");
    expect(matching).toHaveLength(1);
    expect(matching[0]?.entryId).toBe("remote-1");
    expect(await store.listDirtyEntries()).toHaveLength(0);

    // initialSyncMode=download: remote upserts apply to disk; local content is overwritten.
    expect(adapter.text("notes/hello.md")).toBe("REMOTE");
    await store.close();
  });
});

interface RemoteEntryFixture {
  entryId: string;
  path: string;
  revision: number;
  blobId: string;
  hash: string;
  content: string;
}

async function arrangeFreshDevice(input: {
  diskFiles: Record<string, string>;
  remoteEntries: RemoteEntryFixture[];
}) {
  const store = await createInitializedTestSyncStore(createTestPlugin());
  await writeStoredSyncConnection(store, {
    localVaultId: (await store.readSyncConnection())!.localVaultId,
    remoteVaultId: "vault-1",
    lastPulledCursor: 0,
    initialSyncMode: "download",
    initialSyncComplete: false,
  });

  const adapter = createVaultAdapter(input.diskFiles);
  const crypto = new VaultKeyCryptoService(() => TEST_VAULT_KEY);

  const commits = await Promise.all(
    input.remoteEntries.map(async (entry, index) =>
      createCommit({
        cursor: index + 1,
        entryId: entry.entryId,
        revision: entry.revision,
        blobId: entry.blobId,
        encryptedMetadata: await encryptRemoteMetadata({
          entryId: entry.entryId,
          revision: entry.revision,
          blobId: entry.blobId,
          path: entry.path,
          hash: entry.hash,
        }),
      }),
    ),
  );
  const session = createRealtimeSession({
    pages: [
      {
        cursor: input.remoteEntries.length,
        hasMore: false,
        commits,
      },
    ],
  });

  const blobs: Record<string, Uint8Array> = {};
  for (const entry of input.remoteEntries) {
    blobs[entry.blobId] = await encryptTestBlob(
      entry.blobId,
      encodeUtf8(entry.content),
    );
  }
  const pullClient = createPullClient({ blobs });

  const pullService = new SyncPullService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    crypto,
    vaultAdapter: adapter,
    pullClient,
    onProgress: ignoreProgress,
    isInitialDownloadSync: async () => {
      const conn = await store.readSyncConnection();
      return (
        conn?.initialSyncMode === "download" && conn?.initialSyncComplete !== true
      );
    },
    onInitialPullComplete: async () => {
      const conn = await store.readSyncConnection();
      if (!conn) return;
      await store.writeSyncConnection({ ...conn, initialSyncComplete: true });
    },
  });

  const reconcileService = new SyncLocalReconcileService({
    getSyncStore: () => store,
    crypto,
    shouldSyncPath: () => true,
    scanner: {
      async listFiles() {
        return [...adapter.files.entries()].map(([path, bytes]) => ({
          path,
          mtime: 1,
          size: bytes.byteLength,
          async readBytes() {
            return bytes;
          },
        }));
      },
      listFolders() {
        return [];
      },
    },
  });

  return {
    store,
    adapter,
    async runPullThenReconcile() {
      const pull = await pullService.pullOnce(session);
      const reconcile = await reconcileService.reconcileOnce();
      return { pull, reconcile };
    },
  };
}
