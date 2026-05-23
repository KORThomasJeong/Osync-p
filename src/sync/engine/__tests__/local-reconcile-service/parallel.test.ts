import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { encodeUtf8 } from "../../../core/content";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { TEST_VAULT_KEY } from "./helpers";

describe("SyncLocalReconcileService parallel reads", () => {
  it("reads multiple files concurrently when prepareConcurrency > 1", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `file${i}.md`,
      mtime: 1,
      size: 5,
      async readBytes(): Promise<Uint8Array> {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
        return encodeUtf8("hello");
      },
    }));

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return files;
        },
        listFolders: () => [],
      },
      prepareConcurrency: 4,
    });

    const result = await service.reconcileOnce();
    expect(result.filesScanned).toBe(6);
    expect(maxConcurrent).toBeGreaterThan(1);
    await store.close();
  });
});
