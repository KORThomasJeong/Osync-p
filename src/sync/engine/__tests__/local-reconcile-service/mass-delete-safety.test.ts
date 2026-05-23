import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";
import { encodeUtf8, hashBytes } from "../../../core/content";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { MassDeleteGuardError } from "../../mass-delete-guard";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { localFile, TEST_VAULT_KEY } from "./helpers";

async function seedKnownEntries(
  store: Awaited<ReturnType<typeof createInitializedTestSyncStore>>,
  count: number,
): Promise<{ path: string; bytes: Uint8Array }[]> {
  const seeded: { path: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < count; i += 1) {
    const path = `notes/seed-${i}.md`;
    const bytes = encodeUtf8(`body-${i}`);
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: `entry-${i}`,
      path,
      revision: 1,
      blobId: `blob-${i}`,
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    seeded.push({ path, bytes });
  }
  return seeded;
}

describe("SyncLocalReconcileService mass-delete guard", () => {
  it("throws MassDeleteGuardError when disk is empty but store has 60 known entries", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await seedKnownEntries(store, 60);

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [];
        },
        listFolders: () => [],
      },
    });

    await expect(service.reconcileOnce()).rejects.toBeInstanceOf(MassDeleteGuardError);
    await store.close();
  });

  it("does not throw when disk has all files (no deletes queued)", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const seeded = await seedKnownEntries(store, 60);

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return seeded.map((s) => localFile(s.path, s.bytes));
        },
        listFolders: () => [],
      },
    });

    await expect(service.reconcileOnce()).resolves.toBeDefined();
    await store.close();
  });

  it("can be bypassed via { allowMassDelete: true } option", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await seedKnownEntries(store, 60);

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce({ allowMassDelete: true });
    expect(result.filesQueuedForDelete).toBe(60);
    await store.close();
  });
});
