import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { hashBytes } from "../../../core/content";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncPushService } from "../../push-service";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPushService drain: token refresh under long bursts", () => {
  it("re-fetches the sync token for each batch so a long burst never reuses an expired token", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const mutationCount = 250; // > DEFAULT_PUSH_BATCH (100) → at least 3 batches
    const body = new TextEncoder().encode("body");
    const hash = await hashBytes(body);
    for (let index = 0; index < mutationCount; index += 1) {
      await store.markEntryDirty({
        mutationId: `mutation-upsert-${index}`,
        entryId: `entry-upsert-${index}`,
        op: "upsert",
        baseRevision: 0,
        blobId: `blob-upsert-${index}`,
        hash,
        encryptedMetadata: await encryptMutationMetadata({
          entryId: `entry-upsert-${index}`,
          baseRevision: 0,
          op: "upsert",
          blobId: `blob-upsert-${index}`,
          path: `Folder/file-${index}.md`,
          hash,
        }),
        createdAt: index,
      });
    }

    let tokenFetches = 0;
    const session = createPushSession(async (mutation) => ({
      cursor: Number(mutation.mutationId.replace("mutation-upsert-", "")) + 1,
      entryId: mutation.entryId,
      revision: mutation.baseRevision + 1,
    }));
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => {
        tokenFetches += 1;
        return createToken();
      },
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: {
        async readBytes() {
          return body;
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    await service.pushPendingMutations(session);

    // One token fetch per batch (>=3), not a single token reused across the whole burst.
    expect(tokenFetches).toBeGreaterThanOrEqual(3);
  });
});
