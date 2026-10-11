import { describe, expect, it, vi } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { encryptSyncMetadata } from "../../../core/crypto";
import { VaultKeyCryptoService } from "../../../core/crypto-service";
import type { SyncStore } from "../../../store/store";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { decryptPendingMetadata, localFile, TEST_VAULT_KEY } from "./helpers";

const OLD_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => 200 - index));

// A synced entry whose local change was queued while the device held another key.
async function arrangeOldKeyPending(
  store: SyncStore,
  input: { entryId: string; path: string; op: "upsert" | "delete"; localHash: string | null },
): Promise<void> {
  const remoteHash = await hashBytes(encodeUtf8("remote body"));
  await store.applyRemoteState({
    entryId: input.entryId,
    path: input.path,
    revision: 3,
    blobId: `blob-${input.entryId}`,
    hash: remoteHash,
    deleted: false,
    updatedAt: 1,
  });
  await store.applyLocalState({
    entryId: input.entryId,
    path: input.op === "delete" ? null : input.path,
    blobId: input.op === "delete" ? null : `blob-${input.entryId}-local`,
    hash: input.localHash,
    deleted: input.op === "delete",
    updatedAt: 2,
    localMtime: input.op === "delete" ? null : 10,
    localSize: input.op === "delete" ? null : 10,
  });
  const blobId = input.op === "delete" ? null : `blob-${input.entryId}-local`;
  await store.markEntryDirty({
    mutationId: `mutation-${input.entryId}`,
    entryId: input.entryId,
    op: input.op,
    baseRevision: 3,
    blobId,
    hash: input.localHash,
    encryptedMetadata: await encryptSyncMetadata(
      OLD_VAULT_KEY,
      { path: input.path, hash: input.localHash },
      { entryId: input.entryId, revision: 4, op: input.op, blobId },
    ),
    createdAt: 1,
  });
}

function createService(
  store: SyncStore,
  files: Array<ReturnType<typeof localFile>>,
  onUndecryptablePendingDropped = vi.fn(),
) {
  return new SyncLocalReconcileService({
    getSyncStore: () => store,
    crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    shouldSyncPath: () => true,
    scanner: {
      async listFiles() {
        return files;
      },
      listFolders: () => [],
    },
    onUndecryptablePendingDropped,
  });
}

describe("SyncLocalReconcileService with queued changes encrypted with an old key", () => {
  it("does not fail the scan on an unreadable queued delete", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await arrangeOldKeyPending(store, {
      entryId: "entry-gone",
      path: "gone.png",
      op: "delete",
      localHash: null,
    });
    const dropped = vi.fn();

    await expect(createService(store, [], dropped).reconcileOnce()).resolves.toBeDefined();

    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it("re-queues dropped changes with the current key when asked to sanitize the queue", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const editedBytes = encodeUtf8("edited body");
    const editedHash = await hashBytes(editedBytes);
    await arrangeOldKeyPending(store, {
      entryId: "entry-edited",
      path: "edited.png",
      op: "upsert",
      localHash: editedHash,
    });
    await arrangeOldKeyPending(store, {
      entryId: "entry-gone",
      path: "gone.png",
      op: "delete",
      localHash: null,
    });
    const service = createService(store, [localFile("edited.png", editedBytes)]);

    const result = await service.reconcileOnce({ sanitizePendingMetadata: true });

    expect(result.filesQueuedForUpsert).toBe(1);
    expect(result.filesQueuedForDelete).toBe(1);
    const pending = await store.listDirtyEntries();
    expect(pending.map((row) => [row.entryId, row.op]).sort()).toEqual([
      ["entry-edited", "upsert"],
      ["entry-gone", "delete"],
    ]);
    // Both rows are readable with the current key now, against the kept remote base.
    for (const row of pending) {
      expect(row.baseRevision).toBe(3);
      await expect(decryptPendingMetadata(row)).resolves.toBeDefined();
    }
    const upsert = pending.find((row) => row.op === "upsert");
    await expect(decryptPendingMetadata(upsert)).resolves.toEqual({
      path: "edited.png",
      hash: editedHash,
    });
  });
});
