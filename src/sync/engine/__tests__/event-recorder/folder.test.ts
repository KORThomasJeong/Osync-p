import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncEventRecorder } from "../../event-recorder";
import { decryptPendingMetadata, TEST_VAULT_KEY } from "./helpers";

describe("SyncEventRecorder folder methods", () => {
  it("recordFolderUpsert queues a mutation with entryType folder and blobId null", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    });

    const result = await recorder.recordFolderUpsert("MyFolder");

    expect(result).toBe(true);

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      op: "upsert",
      entryType: "folder",
      blobId: null,
      hash: null,
    });
    await expect(decryptPendingMetadata(pending[0])).resolves.toEqual({
      path: "MyFolder",
      hash: null,
    });

    const localState = await store.getLocalStateByPath("MyFolder");
    expect(localState).toMatchObject({
      path: "MyFolder",
      blobId: null,
      hash: null,
      entryType: "folder",
      deleted: false,
    });

    await store.close();
  });

  it("recordFolderUpsert is idempotent — returns false on second call", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    });

    const first = await recorder.recordFolderUpsert("MyFolder");
    const second = await recorder.recordFolderUpsert("MyFolder");

    expect(first).toBe(true);
    expect(second).toBe(false);

    // Only one pending mutation should exist
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);

    await store.close();
  });

  it("recordFolderRename reuses the entryId from the old path", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    });

    // First create the folder at the old path
    await recorder.recordFolderUpsert("OldFolder");
    const oldLocalState = await store.getLocalStateByPath("OldFolder");
    const entryId = oldLocalState?.entryId;
    expect(entryId).toBeTruthy();

    // Now rename it
    const result = await recorder.recordFolderRename("OldFolder", "NewFolder");
    expect(result).toBe(true);

    // Should have the same entryId at the new path
    const newLocalState = await store.getLocalStateByPath("NewFolder");
    expect(newLocalState?.entryId).toBe(entryId);
    expect(newLocalState?.entryType).toBe("folder");
    expect(newLocalState?.path).toBe("NewFolder");

    // Only one mutation for the rename (the upsert was overwritten)
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      entryId,
      op: "upsert",
      entryType: "folder",
      blobId: null,
    });
    await expect(decryptPendingMetadata(pending[0])).resolves.toEqual({
      path: "NewFolder",
      hash: null,
    });

    await store.close();
  });

  it("recordFolderRename falls back to recordFolderUpsert when no existing entry found", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    });

    const result = await recorder.recordFolderRename("NonExistent", "NewFolder");
    expect(result).toBe(true);

    const localState = await store.getLocalStateByPath("NewFolder");
    expect(localState).toMatchObject({
      path: "NewFolder",
      entryType: "folder",
      deleted: false,
    });

    await store.close();
  });
});
