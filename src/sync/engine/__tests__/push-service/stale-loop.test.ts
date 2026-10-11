import { describe, expect, it, vi } from "vitest";

import { hashBytes } from "../../../core/content";
import { encryptSyncMetadata } from "../../../core/crypto";
import { VaultKeyCryptoService } from "../../../core/crypto-service";
import type { RemoteEntryState } from "../../../remote/changes";
import type {
  CommitMutationBatchResult,
  CommitMutationPayload,
  SyncRealtimeSession,
} from "../../../remote/realtime-client";
import type { SyncStore } from "../../../store/store";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncPullService } from "../../pull-service";
import { SyncPushService, type SyncPushServiceDeps } from "../../push-service";
import { StaleEntryResolver } from "../../stale-entry-resolver";
import { unreadablePlaceholderPath } from "../../unreadable-entries";
import {
  createPullClient,
  createVaultAdapter,
  encryptPendingMetadata,
  encryptRemoteMetadata,
  encryptTestBlob,
} from "../pull-service/helpers";
import { createToken, ignoreProgress, TEST_VAULT_KEY } from "./helpers";

const OLD_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => 200 - index));

// A minimal server: current entry states plus revision checks on commit. The stuck
// device's cursor is already past every state, so a pull from it returns nothing.
function createServer(states: RemoteEntryState[]) {
  const byId = new Map(states.map((state) => [state.entryId, state]));
  const committed: CommitMutationPayload[] = [];
  let cursor = 100;
  const session: SyncRealtimeSession = {
    serverCursor: cursor,
    storageUsedBytes: 0,
    storageLimitBytes: 100_000_000,
    maxFileSizeBytes: 3_000_000,
    watchStorageStatus() {},
    unwatchStorageStatus() {},
    async listEntryStates(input) {
      const entries = [...byId.values()]
        .filter((state) => state.updatedSeq > input.sinceCursor)
        .sort((a, b) => a.updatedSeq - b.updatedSeq);
      return {
        targetCursor: cursor,
        totalEntries: entries.length,
        hasMore: false,
        nextAfter: null,
        entries,
      };
    },
    async listEntryVersions() {
      throw new Error("not used");
    },
    async restoreEntryVersion() {
      throw new Error("not used");
    },
    async ping() {},
    async ackCursor() {},
    async commitMutation() {
      throw new Error("not used");
    },
    async commitMutations(mutations) {
      const results: CommitMutationBatchResult[] = [];
      for (const mutation of mutations) {
        committed.push(mutation);
        const current = byId.get(mutation.entryId);
        const currentRevision = current?.revision ?? 0;
        if (mutation.baseRevision !== currentRevision) {
          results.push({
            status: "rejected",
            mutationId: mutation.mutationId,
            entryId: mutation.entryId,
            code: "stale_revision",
            message: "stale",
            expectedBaseRevision: currentRevision,
            receivedBaseRevision: mutation.baseRevision,
          });
          continue;
        }
        cursor += 1;
        byId.set(mutation.entryId, {
          entryId: mutation.entryId,
          revision: currentRevision + 1,
          blobId: mutation.blobId,
          encryptedMetadata: mutation.encryptedMetadata,
          deleted: mutation.op === "delete",
          updatedSeq: cursor,
          updatedAt: cursor,
        });
        results.push({
          status: "accepted",
          mutationId: mutation.mutationId,
          cursor,
          entryId: mutation.entryId,
          revision: currentRevision + 1,
        });
      }
      return { cursor, results };
    },
    close() {},
  };
  return { session, committed };
}

async function arrangeStaleUpsert(
  store: SyncStore,
  input: { entryId: string; path: string; bytes: Uint8Array; editedAt?: number },
) {
  const baseHash = await hashBytes(new TextEncoder().encode("base"));
  const localHash = await hashBytes(input.bytes);
  await store.setCursor(500);
  await store.applyRemoteState({
    entryId: input.entryId,
    path: input.path,
    revision: 3,
    blobId: "blob-base",
    hash: baseHash,
    deleted: false,
    updatedAt: 1,
  });
  await store.applyLocalState({
    entryId: input.entryId,
    path: input.path,
    blobId: "blob-local",
    hash: localHash,
    deleted: false,
    updatedAt: 2,
    localMtime: 10,
    localSize: input.bytes.byteLength,
  });
  await store.markEntryDirty({
    mutationId: `mutation-${input.entryId}`,
    entryId: input.entryId,
    op: "upsert",
    baseRevision: 3,
    baseBlobId: "blob-base",
    baseHash,
    blobId: "blob-local",
    hash: localHash,
    encryptedMetadata: await encryptPendingMetadata({
      entryId: input.entryId,
      baseRevision: 3,
      op: "upsert",
      blobId: "blob-local",
      path: input.path,
      hash: localHash,
      editedAt: input.editedAt,
    }),
    createdAt: 1,
  });
  return { localHash };
}

function createServices(
  store: SyncStore,
  adapter: ReturnType<typeof createVaultAdapter>,
  blobs: Record<string, Uint8Array>,
  overrides: Partial<SyncPushServiceDeps> = {},
) {
  const crypto = new VaultKeyCryptoService(() => TEST_VAULT_KEY);
  const pull = new SyncPullService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    crypto,
    vaultAdapter: adapter,
    pullClient: createPullClient({ blobs }),
    onProgress: ignoreProgress,
    now: () => 1_000,
  });
  const onEntriesDetached = vi.fn();
  const push = new SyncPushService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    crypto,
    fileReader: adapter,
    conflictFileWriter: adapter,
    blobClient: { async uploadBlob() {} },
    onProgress: ignoreProgress,
    staleEntryResolver: new StaleEntryResolver({
      crypto,
      applyRemoteEntryStates: async (states) => {
        await pull.applyRemoteEntryStates(states);
      },
      onEntriesDetached,
    }),
    ...overrides,
  });
  return { push, pull, onEntriesDetached };
}

describe("SyncPushService: stale_revision the pull cannot resolve", () => {
  it("fetches the entry's current state and rebases onto it instead of looping", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const localBytes = new TextEncoder().encode("local edit");
    const remoteBytes = new TextEncoder().encode("remote edit");
    const remoteHash = await hashBytes(remoteBytes);
    await arrangeStaleUpsert(store, {
      entryId: "entry-a",
      path: "pics/a.png",
      bytes: localBytes,
      editedAt: 5_000,
    });
    const adapter = createVaultAdapter({ "pics/a.png": localBytes });
    // Another device committed revision 5 while this device could not read it; the
    // device's cursor (500) is already past it, so pulls never deliver it.
    const server = createServer([
      {
        entryId: "entry-a",
        revision: 5,
        blobId: "blob-remote",
        encryptedMetadata: await encryptRemoteMetadata({
          entryId: "entry-a",
          revision: 5,
          blobId: "blob-remote",
          path: "pics/a.png",
          hash: remoteHash,
          editedAt: 100,
        }),
        deleted: false,
        updatedSeq: 40,
        updatedAt: 100,
      },
    ]);
    const { push } = createServices(store, adapter, {
      "blob-remote": await encryptTestBlob("blob-remote", remoteBytes),
    });

    const first = await push.pushPendingMutations(server.session);
    expect(first.shouldPullAfterPush).toBe(true);
    const second = await push.pushPendingMutations(server.session);
    expect(second.hasMore).toBe(true);
    const third = await push.pushPendingMutations(server.session);

    expect(server.committed.map((mutation) => mutation.baseRevision)).toEqual([3, 3, 5]);
    expect(third.mutationsPushed).toBe(1);
    expect(await store.listDirtyEntries()).toEqual([]);
    // The local edit won (newer editedAt) and is on disk; the remote one was kept aside.
    expect(adapter.bytes("pics/a.png")).toEqual(localBytes);
    const conflictCopies = [...adapter.files.keys()].filter((path) =>
      path.includes("sync-conflict"),
    );
    expect(conflictCopies).toHaveLength(1);
    expect(adapter.bytes(conflictCopies[0]!)).toEqual(remoteBytes);
  });

  it("re-creates the file as a new entry when the server entry was removed as unreadable", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const localBytes = new TextEncoder().encode("local edit");
    await arrangeStaleUpsert(store, { entryId: "entry-b", path: "pics/b.png", bytes: localBytes });
    const adapter = createVaultAdapter({ "pics/b.png": localBytes });
    const server = createServer([
      {
        entryId: "entry-b",
        revision: 6,
        blobId: null,
        encryptedMetadata: await encryptSyncMetadata(
          TEST_VAULT_KEY,
          { path: unreadablePlaceholderPath("entry-b"), hash: null },
          { entryId: "entry-b", revision: 6, op: "delete", blobId: null },
        ),
        deleted: true,
        updatedSeq: 41,
        updatedAt: 100,
      },
    ]);
    const { push, onEntriesDetached } = createServices(store, adapter, {});

    await push.pushPendingMutations(server.session);
    await push.pushPendingMutations(server.session);

    expect(onEntriesDetached).toHaveBeenCalledWith(["entry-b"]);
    // Forgotten locally (the scan uploads the file under a new entryId); file kept.
    expect(await store.getEntryStateById("entry-b")).toBeNull();
    expect(adapter.bytes("pics/b.png")).toEqual(localBytes);
    expect((await push.pushPendingMutations(server.session)).hasMore).toBe(false);
    expect(server.committed).toHaveLength(2);
  });

  it("re-creates the file as a new entry when the server entry is unreadable with this key", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const localBytes = new TextEncoder().encode("local edit");
    await arrangeStaleUpsert(store, { entryId: "entry-c", path: "pics/c.png", bytes: localBytes });
    const adapter = createVaultAdapter({ "pics/c.png": localBytes });
    const server = createServer([
      {
        entryId: "entry-c",
        revision: 4,
        blobId: "blob-old-key",
        encryptedMetadata: await encryptSyncMetadata(
          OLD_VAULT_KEY,
          { path: "pics/c.png", hash: "x" },
          { entryId: "entry-c", revision: 4, op: "upsert", blobId: "blob-old-key" },
        ),
        deleted: false,
        updatedSeq: 42,
        updatedAt: 100,
      },
    ]);
    const { push, onEntriesDetached } = createServices(store, adapter, {});

    await push.pushPendingMutations(server.session);
    await push.pushPendingMutations(server.session);

    expect(onEntriesDetached).toHaveBeenCalledWith(["entry-c"]);
    expect(await store.getEntryStateById("entry-c")).toBeNull();
    expect(adapter.bytes("pics/c.png")).toEqual(localBytes);
  });

  it("blocks a mutation the server keeps rejecting and stops retrying it", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const localBytes = new TextEncoder().encode("local edit");
    await arrangeStaleUpsert(store, { entryId: "entry-d", path: "pics/d.png", bytes: localBytes });
    const adapter = createVaultAdapter({ "pics/d.png": localBytes });
    // The server reports a newer revision but never lists the entry, so nothing can
    // resolve the rejection.
    const server = createServer([]);
    server.session.commitMutations = async (mutations) => {
      server.committed.push(...mutations);
      return {
        cursor: 100,
        results: mutations.map((mutation) => ({
          status: "rejected" as const,
          mutationId: mutation.mutationId,
          entryId: mutation.entryId,
          code: "stale_revision",
          message: "stale",
          expectedBaseRevision: 9,
          receivedBaseRevision: mutation.baseRevision,
        })),
      };
    };
    const onMutationBlocked = vi.fn();
    const { push } = createServices(store, adapter, {}, { onMutationBlocked });

    let last = await push.pushPendingMutations(server.session);
    for (let attempt = 1; attempt < 10 && last.hasMore; attempt += 1) {
      last = await push.pushPendingMutations(server.session);
    }

    expect(server.committed).toHaveLength(5);
    expect(last.hasMore).toBe(false);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getDirtyEntryMutation("entry-d")).toMatchObject({
      status: "blocked",
      blockedReason: "repeated_rejection",
    });
    expect(onMutationBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "entry-d", path: "pics/d.png", code: "stale_revision" }),
    );
    // The file itself is untouched.
    expect(adapter.bytes("pics/d.png")).toEqual(localBytes);
  });
});
