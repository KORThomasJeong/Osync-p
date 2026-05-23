import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { encodeUtf8, hashBytes } from "../../../core/content";
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

describe("SyncPushService drain: batching", () => {
  it("reports whole-store progress instead of capping totals at the drain limit", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const mutationCount = 1_001;
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

    const progressUpdates: Array<{ completedEntries: number; totalEntries: number }> = [];
    const session = createPushSession(async (mutation) => ({
      cursor: Number(mutation.mutationId.replace("mutation-upsert-", "")) + 1,
      entryId: mutation.entryId,
      revision: mutation.baseRevision + 1,
    }));
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
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
      onProgress: async (progress) => {
        progressUpdates.push(progress);
      },
    });

    const result = await service.pushPendingMutations(session);

    expect(result.mutationsPushed).toBe(1_000);
    expect(result.hasMore).toBe(true);
    expect(progressUpdates[0]).toEqual({
      completedEntries: 100,
      totalEntries: mutationCount,
    });
    expect(progressUpdates.at(-1)).toEqual({
      completedEntries: 1_000,
      totalEntries: mutationCount,
    });
    await store.close();
  });

  it("prepares blob uploads concurrently while committing in queue order", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const bodies = ["first body", "second body", "third body"];
    for (let index = 0; index < bodies.length; index += 1) {
      const hash = await hashBytes(encodeUtf8(bodies[index]));
      await store.markEntryDirty({
        mutationId: `mutation-${index}`,
        entryId: `entry-${index}`,
        op: "upsert",
        baseRevision: 0,
        blobId: `blob-${index}`,
        hash,
        encryptedMetadata: await encryptMutationMetadata({
          entryId: `entry-${index}`,
          baseRevision: 0,
          op: "upsert",
          blobId: `blob-${index}`,
          path: `Folder/file-${index}.md`,
          hash,
        }),
        createdAt: index,
      });
    }

    const committed: Array<CommitMutationPayload> = [];
    const uploadStarts: string[] = [];
    const uploadDeferreds = new Map<string, Deferred<void>>();
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      return {
        cursor: committed.length,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      prepareConcurrency: 2,
      fileReader: {
        async readBytes(path) {
          const match = /^Folder\/file-(\d+)\.md$/.exec(path);
          if (!match) {
            throw new Error(`unexpected read for ${path}`);
          }

          return new TextEncoder().encode(bodies[Number(match[1])]);
        },
      },
      blobClient: {
        async uploadBlob(_apiBaseUrl, _syncToken, _vaultId, blobId) {
          uploadStarts.push(blobId);
          const deferred = createDeferred<void>();
          uploadDeferreds.set(blobId, deferred);
          activeUploads += 1;
          maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
          try {
            await deferred.promise;
          } finally {
            activeUploads -= 1;
          }
        },
      },
      onProgress: ignoreProgress,
    });

    const pushPromise = service.pushPendingMutations(session);
    await waitFor(() => uploadStarts.length === 2);
    expect(uploadStarts).toHaveLength(2);
    expect(new Set(uploadStarts)).toEqual(new Set(["blob-0", "blob-1"]));
    expect(maxActiveUploads).toBe(2);

    uploadDeferreds.get("blob-1")?.resolve();
    await waitFor(() => uploadStarts.length === 3);
    expect(committed).toEqual([]);

    uploadDeferreds.get("blob-2")?.resolve();
    uploadDeferreds.get("blob-0")?.resolve();
    await pushPromise;

    expect(committed.map((mutation) => mutation.blobId)).toEqual(["blob-0", "blob-1", "blob-2"]);
    expect(maxActiveUploads).toBe(2);
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("condition was not met");
}
