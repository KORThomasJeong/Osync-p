import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncEventRecorder } from "../../event-recorder";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import {
  decryptPendingMetadata,
  encryptTestMetadata,
  localFile,
  putTestBaseBlob,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncLocalReconcileService queueing", () => {
  it("queues new files and server-backed deletes from a local snapshot", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 2,
      blobId: "blob-old",
      hash: "old-hash",
      deleted: false,
      updatedAt: 1,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Folder/new.md", encodeUtf8("new body")),
          ];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 1,
    });

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(2);
    expect(pending.map((item) => item.op).sort()).toEqual(["delete", "upsert"]);
    const upsertMutation = pending.find((item) => item.op === "upsert");
    await expect(
      decryptPendingMetadata(upsertMutation),
    ).resolves.toEqual({
      path: "Folder/new.md",
      hash: await hashBytes(encodeUtf8("new body")),
    });
    expect(upsertMutation?.blobId).toEqual(expect.any(String));
    expect(upsertMutation?.hash).toBe(await hashBytes(encodeUtf8("new body")));
    const deleteMutation = pending.find((item) => item.op === "delete");
    await expect(
      decryptPendingMetadata(deleteMutation),
    ).resolves.toEqual({
      path: "Folder/deleted.md",
      hash: null,
    });
    expect(await store.getEntryById("entry-deleted")).toEqual({
      entryId: "entry-deleted",
      entryType: "file",
      path: null,
      revision: 2,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });
    await store.close();
  });

  it("reuses the same entry id when a file was renamed with identical content", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const hash = await hashBytes(encodeUtf8("same body"));
    await store.upsertEntry({
      entryId: "entry-rename",
      path: "Old/name.md",
      revision: 4,
      blobId: "blob-rename",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-rename",
      hash,
      bytes: encodeUtf8("same body"),
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("New/name.md", encodeUtf8("same body")),
          ];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      mutationId: expect.any(String),
      entryId: "entry-rename",
      op: "upsert",
      baseRevision: 4,
      blobId: expect.any(String),
      hash,
      encryptedMetadata: expect.any(String),
      createdAt: expect.any(Number),
    });
    await expect(
      decryptPendingMetadata(await store.getDirtyEntryMutation("entry-rename")),
    ).resolves.toEqual({
      path: "New/name.md",
      hash,
    });
    await store.close();
  });

  it("does not reconcile a new file onto an entry renamed locally", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const oldPath = "Old/name.md";
    const nextPath = "New/name.md";
    const renamedBytes = encodeUtf8("renamed body");
    const renamedHash = await hashBytes(renamedBytes);
    const newBytes = encodeUtf8("new body at old path");
    const newHash = await hashBytes(newBytes);
    await store.upsertEntry({
      entryId: "entry-renamed",
      path: oldPath,
      revision: 4,
      blobId: "blob-renamed",
      hash: renamedHash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-renamed",
      hash: renamedHash,
      bytes: renamedBytes,
    });
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    });
    await recorder.recordRename(oldPath, nextPath, renamedBytes);

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile(oldPath, newBytes),
            localFile(nextPath, renamedBytes),
          ];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 2,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });
    expect(await store.getEntryByPath(nextPath)).toMatchObject({
      entryId: "entry-renamed",
      revision: 4,
      path: nextPath,
      hash: renamedHash,
    });
    const newEntry = await store.getEntryByPath(oldPath);
    const newEntryId = newEntry?.entryId;
    expect(newEntry).toMatchObject({
      entryId: expect.any(String),
      revision: 0,
      path: oldPath,
      hash: newHash,
    });
    expect(newEntryId).not.toBe("entry-renamed");

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(2);
    await expect(
      decryptPendingMetadata(await store.getDirtyEntryMutation("entry-renamed")),
    ).resolves.toEqual({
      path: nextPath,
      hash: renamedHash,
    });
    await expect(
      decryptPendingMetadata(await store.getDirtyEntryMutation(newEntryId ?? "")),
    ).resolves.toEqual({
      path: oldPath,
      hash: newHash,
    });
    await store.close();
  });

  it("reuses existing remote blob ids for binary renames", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const imageBytes = new Uint8Array([9, 8, 7, 6, 5]);
    const imageHash = await hashBytes(imageBytes);
    await store.upsertEntry({
      entryId: "entry-image",
      path: "Assets/old.png",
      revision: 3,
      blobId: "blob-image",
      hash: imageHash,
      deleted: false,
      updatedAt: 1,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Assets/new.png", imageBytes),
          ];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      mutationId: expect.any(String),
      entryId: "entry-image",
      op: "upsert",
      baseRevision: 3,
      blobId: "blob-image",
      hash: imageHash,
      encryptedMetadata: expect.any(String),
      createdAt: expect.any(Number),
    });
    await expect(
      decryptPendingMetadata(await store.getDirtyEntryMutation("entry-image")),
    ).resolves.toEqual({
      path: "Assets/new.png",
      hash: imageHash,
    });

    await store.close();
  });

  it("preserves pending upsert mutations for files matching the local snapshot", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const bytes = encodeUtf8("same body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-synced",
      path: "Notes/synced.md",
      revision: 7,
      blobId: "blob-synced",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-pending",
      entryId: "entry-synced",
      op: "upsert",
      baseRevision: 7,
      blobId: "blob-synced",
      hash,
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-synced",
        revision: 8,
        op: "upsert",
        blobId: "blob-synced",
        path: "Notes/synced.md",
        hash,
      }),
      createdAt: 2,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Notes/synced.md", bytes),
          ];
        },
        listFolders: () => [],
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    expect(await store.listDirtyEntries()).toHaveLength(1);
    expect(await store.getDirtyEntryMutation("entry-synced")).toMatchObject({
      mutationId: "mutation-pending",
      entryId: "entry-synced",
      op: "upsert",
      baseRevision: 7,
      blobId: "blob-synced",
      hash,
    });
    expect(await store.getEntryByPath("Notes/synced.md")).toMatchObject({
      entryId: "entry-synced",
      revision: 7,
      blobId: "blob-synced",
      hash,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await store.close();
  });

  it("replaces a pending delete when the file is restored before push", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const bytes = encodeUtf8("same body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-restored",
      path: "Notes/restored.md",
      revision: 3,
      blobId: "blob-restored",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-restored",
      hash,
      bytes,
    });

    let files = [] as ReturnType<typeof localFile>[];
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
    });

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 0,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 1,
    });
    expect(await store.getEntryById("entry-restored")).toMatchObject({
      entryId: "entry-restored",
      path: null,
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      localMtime: null,
      localSize: null,
    });

    files = [localFile("Notes/restored.md", bytes)];

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      entryId: "entry-restored",
      op: "upsert",
      baseRevision: 3,
      hash,
    });
    await expect(decryptPendingMetadata(pending[0])).resolves.toEqual({
      path: "Notes/restored.md",
      hash,
    });
    expect(await store.getEntryByPath("Notes/restored.md")).toMatchObject({
      entryId: "entry-restored",
      revision: 3,
      hash,
      deleted: false,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await store.close();
  });
});
