import { describe, expect, it } from "vitest";

import { VaultKeyCryptoService } from "../../../core/crypto-service";
import { DEFAULT_SYNC_FILE_RULES } from "../../../core/file-rules";
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
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPullService excluded folders", () => {
  it("does not write a remote entry whose path is in an excluded folder, but records its remote state", async () => {
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
              entryId: "excluded-1",
              revision: 1,
              blobId: "blob-excluded",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "excluded-1",
                revision: 1,
                blobId: "blob-excluded",
                path: "Wiki/_retrieval/doc.md",
                hash: await hashText("retrieval body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-excluded": await encryptTestBlob(
          "blob-excluded",
          new TextEncoder().encode("retrieval body"),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
      getSyncFileRules: () => ({
        ...DEFAULT_SYNC_FILE_RULES,
        excludedFolders: ["Wiki/_retrieval"],
      }),
      onProgress: ignoreProgress,
    });

    const result = await service.pullOnce(session);

    // File is NOT written to disk (excluded).
    expect(adapter.files.has("Wiki/_retrieval/doc.md")).toBe(false);
    expect(adapter.files.size).toBe(0);

    // But remote state IS recorded and the cursor advances, so the entry is not
    // re-downloaded on every subsequent pull (breaks the churn loop).
    expect(result.cursor).toBe(1);
    const remote = await store.getRemoteStateById("excluded-1");
    expect(remote).not.toBeNull();
    expect(remote?.revision).toBe(1);

    await store.close();
  });

  it("still writes remote entries outside excluded folders", async () => {
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
              entryId: "included-1",
              revision: 1,
              blobId: "blob-included",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "included-1",
                revision: 1,
                blobId: "blob-included",
                path: "Notes/keep.md",
                hash: await hashText("keep body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-included": await encryptTestBlob(
          "blob-included",
          new TextEncoder().encode("keep body"),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
      getSyncFileRules: () => ({
        ...DEFAULT_SYNC_FILE_RULES,
        excludedFolders: ["Wiki/_retrieval"],
      }),
      onProgress: ignoreProgress,
    });

    await service.pullOnce(session);

    expect(adapter.text("Notes/keep.md")).toBe("keep body");

    await store.close();
  });
});
