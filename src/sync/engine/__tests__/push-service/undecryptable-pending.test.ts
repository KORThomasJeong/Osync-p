import { describe, expect, it, vi } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { encryptSyncMetadata } from "../../../core/crypto";
import { VaultKeyCryptoService } from "../../../core/crypto-service";
import type { CommitMutationPayload } from "../../../remote/realtime-client";
import type { SyncStore } from "../../../store/store";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncPushService } from "../../push-service";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

// The key this device used before it was given the vault's real key.
const OLD_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => 200 - index));

async function encryptWithOldKey(input: {
  entryId: string;
  baseRevision: number;
  op: "upsert" | "delete";
  blobId: string | null;
  path: string;
  hash: string | null;
}): Promise<string> {
  return await encryptSyncMetadata(
    OLD_VAULT_KEY,
    { path: input.path, hash: input.hash },
    {
      entryId: input.entryId,
      revision: input.baseRevision + 1,
      op: input.op,
      blobId: input.blobId,
    },
  );
}

async function arrangeSyncedEntry(
  store: SyncStore,
  input: { entryId: string; path: string; revision: number; blobId: string; hash: string },
): Promise<void> {
  await store.applyRemoteState({
    entryId: input.entryId,
    path: input.path,
    revision: input.revision,
    blobId: input.blobId,
    hash: input.hash,
    deleted: false,
    updatedAt: 1,
  });
}

function createService(
  store: SyncStore,
  files: Record<string, string>,
  onUndecryptablePendingDropped = vi.fn(),
) {
  return new SyncPushService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    fileReader: {
      async readBytes(path) {
        const body = files[path];
        if (body === undefined) {
          throw new Error(`missing ${path}`);
        }
        return encodeUtf8(body);
      },
    },
    blobClient: { async uploadBlob() {} },
    onProgress: ignoreProgress,
    onUndecryptablePendingDropped,
  });
}

describe("SyncPushService: pending mutations encrypted with an old key", () => {
  it("drops them instead of failing the drain, and still commits the readable ones", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const remoteHash = await hashBytes(encodeUtf8("remote body"));
    const editedHash = await hashBytes(encodeUtf8("edited body"));
    const freshHash = await hashBytes(encodeUtf8("fresh body"));
    await arrangeSyncedEntry(store, {
      entryId: "entry-old-upsert",
      path: "old.md",
      revision: 3,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    await store.applyLocalState({
      entryId: "entry-old-upsert",
      path: "old.md",
      blobId: "blob-edited",
      hash: editedHash,
      deleted: false,
      updatedAt: 2,
      localMtime: 5,
      localSize: 11,
    });
    await store.markEntryDirty({
      mutationId: "mutation-old-upsert",
      entryId: "entry-old-upsert",
      op: "upsert",
      baseRevision: 3,
      baseBlobId: "blob-remote",
      baseHash: remoteHash,
      blobId: "blob-edited",
      hash: editedHash,
      encryptedMetadata: await encryptWithOldKey({
        entryId: "entry-old-upsert",
        baseRevision: 3,
        op: "upsert",
        blobId: "blob-edited",
        path: "old.md",
        hash: editedHash,
      }),
      createdAt: 1,
    });
    await arrangeSyncedEntry(store, {
      entryId: "entry-old-delete",
      path: "gone.md",
      revision: 7,
      blobId: "blob-gone",
      hash: remoteHash,
    });
    await store.applyLocalState({
      entryId: "entry-old-delete",
      path: null,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 2,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-old-delete",
      entryId: "entry-old-delete",
      op: "delete",
      baseRevision: 7,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptWithOldKey({
        entryId: "entry-old-delete",
        baseRevision: 7,
        op: "delete",
        blobId: null,
        path: "gone.md",
        hash: null,
      }),
      createdAt: 2,
    });
    await store.markEntryDirty({
      mutationId: "mutation-fresh",
      entryId: "entry-fresh",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-fresh",
      hash: freshHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-fresh",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-fresh",
        path: "fresh.md",
        hash: freshHash,
      }),
      createdAt: 3,
    });

    const committed: CommitMutationPayload[] = [];
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      return { cursor: 20, entryId: mutation.entryId, revision: mutation.baseRevision + 1 };
    });
    const dropped = vi.fn();
    const service = createService(
      store,
      { "old.md": "edited body", "fresh.md": "fresh body" },
      dropped,
    );

    const result = await service.pushPendingMutations(session);

    // Old-key metadata never reaches the server (it would be unreadable there).
    expect(committed.map((mutation) => mutation.entryId)).toEqual(["entry-fresh"]);
    expect(result.mutationsPushed).toBe(1);
    expect(result.mutationsDropped).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(dropped).toHaveBeenCalledTimes(2);
    expect(await store.listDirtyEntries()).toEqual([]);

    // Remote state is kept; local state falls back to it so the next scan sees the
    // file on disk differ from what is known and queues it again with the current key.
    expect(await store.getRemoteStateById("entry-old-upsert")).toMatchObject({
      revision: 3,
      hash: remoteHash,
    });
    expect(await store.getLocalStateById("entry-old-upsert")).toMatchObject({
      path: "old.md",
      hash: remoteHash,
      deleted: false,
      localMtime: null,
    });
    expect(await store.getLocalStateById("entry-old-delete")).toMatchObject({
      path: "gone.md",
      deleted: false,
    });
  });

  it("forgets a never-committed entry whose only pending upsert is unreadable", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const hash = await hashBytes(encodeUtf8("new body"));
    await store.applyLocalState({
      entryId: "entry-new",
      path: "new.md",
      blobId: "blob-new",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 1,
      localSize: 8,
    });
    await store.markEntryDirty({
      mutationId: "mutation-new",
      entryId: "entry-new",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-new",
      hash,
      encryptedMetadata: await encryptWithOldKey({
        entryId: "entry-new",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-new",
        path: "new.md",
        hash,
      }),
      createdAt: 1,
    });
    const session = createPushSession(async () => {
      throw new Error("nothing should be committed");
    });

    const result = await createService(store, { "new.md": "new body" }).pushPendingMutations(
      session,
    );

    expect(result.mutationsDropped).toBe(1);
    expect(await store.getEntryStateById("entry-new")).toBeNull();
  });
});
