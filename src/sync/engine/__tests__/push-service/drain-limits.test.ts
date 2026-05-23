import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { SyncBlobUploadError } from "../../../remote/blob-client";
import type { CommitMutationPayload } from "../../../remote/realtime-client";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncPushService } from "../../push-service";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPushService drain: limits", () => {
  it("blocks upserts whose encrypted blob exceeds the server file size limit", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const bytes = encodeUtf8("new body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-too-large",
      path: "Folder/too-large.md",
      revision: 0,
      blobId: "blob-too-large",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-too-large",
      entryId: "entry-too-large",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-too-large",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-too-large",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-too-large",
        path: "Folder/too-large.md",
        hash,
      }),
      createdAt: 1,
    });

    const session = createPushSession(async () => {
      throw new Error("oversized mutation should not be committed");
    });
    session.maxFileSizeBytes = 1;
    let uploaded = false;
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/too-large.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploaded = true;
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toEqual({
      cursor: 0,
      mutationsPushed: 0,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(uploaded).toBe(false);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getDirtyEntryMutation("entry-too-large")).toMatchObject({
      mutationId: "mutation-too-large",
      status: "blocked",
      blockedReason: "file_too_large",
    });
    expect(await store.getEntryById("entry-too-large")).toMatchObject({
      entryId: "entry-too-large",
      path: "Folder/too-large.md",
      hash,
    });
    await store.close();
  });

  it("allows upserts when the server reports an unlimited file size policy", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const bytes = encodeUtf8("body that is larger than the hosted test limit");
    const hash = await hashBytes(bytes);
    await store.applyLocalState({
      entryId: "entry-unlimited-size",
      path: "Folder/unlimited-size.md",
      hash,
      mtime: 1,
      size: bytes.byteLength,
    });
    await store.applyRemoteState({
      entryId: "entry-unlimited-size",
      path: "Folder/unlimited-size.md",
      revision: 0,
      blobId: null,
      hash: null,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-unlimited-size",
      entryId: "entry-unlimited-size",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-unlimited-size",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-unlimited-size",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-unlimited-size",
        path: "Folder/unlimited-size.md",
        hash,
      }),
      createdAt: 1,
    });

    const session = createPushSession(async (mutation) => ({
      cursor: 1,
      entryId: mutation.entryId,
      revision: 1,
    }));
    session.maxFileSizeBytes = 0;
    let uploaded = false;
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/unlimited-size.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploaded = true;
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      cursor: 1,
      mutationsPushed: 1,
      hasMore: false,
    });
    expect(uploaded).toBe(true);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getDirtyEntryMutation("entry-unlimited-size")).toBeNull();
    await store.close();
  });

  it("allows metadata-only upserts at the initial storage quota", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const bytes = encodeUtf8("body");
    const hash = await hashBytes(bytes);
    await store.applyRemoteState({
      entryId: "entry-rename",
      path: "Folder/old.md",
      revision: 4,
      blobId: "blob-rename",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await store.applyLocalState({
      entryId: "entry-rename",
      path: "Folder/new.md",
      blobId: "blob-rename",
      hash,
      deleted: false,
      updatedAt: 2,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-rename",
      entryId: "entry-rename",
      op: "upsert",
      baseRevision: 4,
      baseBlobId: "blob-rename",
      baseHash: hash,
      blobId: "blob-rename",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-rename",
        baseRevision: 4,
        op: "upsert",
        blobId: "blob-rename",
        path: "Folder/new.md",
        hash,
      }),
      createdAt: 1,
    });

    const committed: CommitMutationPayload[] = [];
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      return {
        cursor: 1,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    session.storageUsedBytes = 100;
    session.storageLimitBytes = 100;
    let uploadAttempts = 0;
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/new.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploadAttempts += 1;
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      cursor: 1,
      mutationsPushed: 1,
      hasMore: false,
    });
    expect(uploadAttempts).toBe(1);
    expect(committed).toHaveLength(1);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getRemoteStateById("entry-rename")).toMatchObject({
      path: "Folder/new.md",
      revision: 5,
      blobId: "blob-rename",
      hash,
    });
    await store.close();
  });

  it("blocks upserts when the server reports quota exhaustion during upload", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const bytes = encodeUtf8("body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-server-quota",
      path: "Folder/server-quota.md",
      revision: 0,
      blobId: "blob-server-quota",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-server-quota",
      entryId: "entry-server-quota",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-server-quota",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-server-quota",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-server-quota",
        path: "Folder/server-quota.md",
        hash,
      }),
      createdAt: 1,
    });

    const session = createPushSession(async () => {
      throw new Error("quota-blocked mutation should not be committed");
    });
    let uploadAttempts = 0;
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/server-quota.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploadAttempts += 1;
          throw new SyncBlobUploadError(413, "quota_exceeded", "quota exceeded");
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      mutationsPushed: 0,
      mutationsRequeued: 0,
      hasMore: false,
    });
    expect(uploadAttempts).toBe(1);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getDirtyEntryMutation("entry-server-quota")).toMatchObject({
      mutationId: "mutation-server-quota",
      status: "blocked",
      blockedReason: "storage_quota_exceeded",
    });
    await store.close();
  });

});
