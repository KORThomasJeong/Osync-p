import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { decryptSyncBlob, decryptSyncMetadata } from "../../../core/crypto";
import type { CommitMutationPayload } from "../../../remote/realtime-client";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncPushService } from "../../push-service";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  metadataContextFromPayload,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPushService drain: basic queue", () => {
  it("flushes queued mutations and updates the local store", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const upsertHash = await hashBytes(encodeUtf8("new body"));
    const upsertBlobId = "blob-upsert-uuid";
    await store.markEntryDirty({
      mutationId: "mutation-upsert",
      entryId: "entry-upsert",
      op: "upsert",
      baseRevision: 0,
      blobId: upsertBlobId,
      hash: upsertHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-upsert",
        baseRevision: 0,
        op: "upsert",
        blobId: upsertBlobId,
        path: "Folder/new.md",
        hash: upsertHash,
      }),
      createdAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete",
      entryId: "entry-deleted",
      op: "delete",
      baseRevision: 2,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-deleted",
        baseRevision: 2,
        op: "delete",
        blobId: null,
        path: "Folder/deleted.md",
      }),
      createdAt: 2,
    });

    const committed: Array<CommitMutationPayload> = [];
    const uploaded: Array<{ blobId: string; bytes: Uint8Array }> = [];
    const progressUpdates: Array<{ completedEntries: number; totalEntries: number }> = [];
    let nextCursor = 10;
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      nextCursor += 1;
      return {
        cursor: nextCursor,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/new.md") {
            return new TextEncoder().encode("new body");
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob(_apiBaseUrl, _syncToken, _vaultId, blobId, bytes) {
          uploaded.push({
            blobId,
            bytes,
          });
        },
      },
      onProgress: async (progress) => {
        progressUpdates.push(progress);
      },
    });

    const result = await service.pushPendingMutations(session);

    expect(result).toEqual({
      cursor: 12,
      mutationsPushed: 2,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 1,
      filesDeleted: 1,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(progressUpdates).toEqual([{ completedEntries: 1, totalEntries: 1 }]);
    expect(committed.map(({ entryId, op, baseRevision }) => ({ entryId, op, baseRevision }))).toEqual(
      [
        {
          entryId: "entry-upsert",
          op: "upsert",
          baseRevision: 0,
        },
        {
          entryId: "entry-deleted",
          op: "delete",
          baseRevision: 2,
        },
      ],
    );
    expect(uploaded).toHaveLength(1);
    expect(new TextDecoder().decode(uploaded[0]?.bytes ?? new Uint8Array())).not.toBe("new body");
    await expect(
      decryptSyncBlob(TEST_VAULT_KEY, uploaded[0]?.bytes ?? new Uint8Array(), {
        blobId: uploaded[0]?.blobId ?? "",
      }),
    ).resolves.toEqual(new TextEncoder().encode("new body"));
    await expect(
      decryptSyncMetadata(
        TEST_VAULT_KEY,
        committed[0]?.encryptedMetadata ?? "",
        metadataContextFromPayload(committed[0]),
      ),
    ).resolves.toEqual({
      path: "Folder/new.md",
      hash: upsertHash,
    });
    expect(uploaded[0]?.blobId).toBe(upsertBlobId);
    expect(await store.getCursor()).toBe(12);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getEntryByPath("Folder/new.md")).toEqual({
      entryId: "entry-upsert",
      entryType: "file",
      path: "Folder/new.md",
      revision: 1,
      blobId: upsertBlobId,
      hash: upsertHash,
      deleted: false,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });
    expect(await store.getEntryById("entry-deleted")).toEqual({
      entryId: "entry-deleted",
      entryType: "file",
      path: "Folder/deleted.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });
    await store.close();
  });

  it("returns without using the realtime session when the queue is empty", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    let committed = false;
    const session = createPushSession(async () => {
      committed = true;
      throw new Error("should not commit");
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: {
        async readBytes() {
          throw new Error("should not read bytes");
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
    expect(committed).toBe(false);
    await store.close();
  });

});
