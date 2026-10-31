import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncPushService } from "../../push-service";
import { createPushSession, createToken, encryptMutationMetadata, TEST_VAULT_KEY } from "./helpers";

async function queueUpsert(
  store: Awaited<ReturnType<typeof createInitializedTestSyncStore>>,
  entryId: string,
  path: string,
  createdAt: number,
): Promise<void> {
  const hash = await hashBytes(encodeUtf8(path));
  await store.markEntryDirty({
    mutationId: `mutation-${entryId}`,
    entryId,
    op: "upsert",
    baseRevision: 0,
    blobId: `blob-${entryId}`,
    hash,
    encryptedMetadata: await encryptMutationMetadata({
      entryId,
      baseRevision: 0,
      op: "upsert",
      blobId: `blob-${entryId}`,
      path,
      hash,
    }),
    createdAt,
  });
}

function createService(store: Awaited<ReturnType<typeof createInitializedTestSyncStore>>) {
  return new SyncPushService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    fileReader: {
      async readBytes(path) {
        return encodeUtf8(path);
      },
    },
    blobClient: {
      async uploadBlob() {},
    },
    onProgress: async () => {},
  });
}

describe("SyncPushService: local cursor after own commits", () => {
  it("does not jump past commits from other devices that were never pulled", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    await store.setCursor(10);
    await queueUpsert(store, "entry-a", "a.md", 1);
    await queueUpsert(store, "entry-b", "b.md", 2);

    // Our first commit lands at 11. Before the second, another device commits 12 and
    // 13, so ours lands at 14.
    const cursors = [11, 14];
    const session = createPushSession(async (mutation) => ({
      cursor: cursors.shift()!,
      entryId: mutation.entryId,
      revision: mutation.baseRevision + 1,
    }));

    const result = await createService(store).pushPendingMutations(session);

    expect(result.mutationsPushed).toBe(2);
    expect(result.cursor).toBe(11);
    expect(result.shouldPullAfterPush).toBe(true);
    expect(await store.getCursor()).toBe(11);
  });

  it("advances through consecutive own commits", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    await store.setCursor(10);
    await queueUpsert(store, "entry-a", "a.md", 1);
    await queueUpsert(store, "entry-b", "b.md", 2);

    let next = 10;
    const session = createPushSession(async (mutation) => ({
      cursor: ++next,
      entryId: mutation.entryId,
      revision: mutation.baseRevision + 1,
    }));

    const result = await createService(store).pushPendingMutations(session);

    expect(result.cursor).toBe(12);
    expect(result.shouldPullAfterPush).toBe(false);
    expect(await store.getCursor()).toBe(12);
  });
});
