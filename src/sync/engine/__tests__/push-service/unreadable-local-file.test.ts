import { afterEach, describe, expect, it, vi } from "vitest";
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

// One queued upload whose file cannot be read right now (locked, removed outside the
// app, permission error) must not fail the whole push and hold up every other upload.
describe("SyncPushService: a local file that cannot be read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves that change queued, pushes the others, and does not report more work", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const bodies = ["locked body", "second body", "third body"];
    for (let index = 0; index < bodies.length; index += 1) {
      const hash = await hashBytes(encodeUtf8(bodies[index]!));
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

    const committed: CommitMutationPayload[] = [];
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      return {
        cursor: committed.length,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const reads: string[] = [];
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: {
        async readBytes(path) {
          reads.push(path);
          const index = Number(/file-(\d+)\.md$/.exec(path)?.[1]);
          if (index === 0) {
            throw new Error("EBUSY: resource busy or locked");
          }
          return encodeUtf8(bodies[index]!);
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    const result = await service.pushPendingMutations(session);

    expect(committed.map((mutation) => mutation.entryId)).toEqual(["entry-1", "entry-2"]);
    expect(result.mutationsPushed).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(reads.filter((path) => path === "Folder/file-0.md")).toHaveLength(1);
    expect((await store.listDirtyEntries()).map((mutation) => mutation.mutationId)).toEqual([
      "mutation-0",
    ]);
    await store.close();
  });

  it("re-queues a malformed queued change from the file instead of failing every push", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const bodies = ["broken row body", "second body"];
    for (let index = 0; index < bodies.length; index += 1) {
      const hash = await hashBytes(encodeUtf8(bodies[index]!));
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
          // The first row's metadata disagrees with its own hash column.
          hash: index === 0 ? "some-other-hash" : hash,
        }),
        createdAt: index,
      });
    }
    const committed: CommitMutationPayload[] = [];
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
      fileReader: {
        async readBytes(path) {
          return encodeUtf8(bodies[Number(/file-(\d+)\.md$/.exec(path)?.[1])]!);
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    const result = await service.pushPendingMutations(session);

    expect(committed.map((mutation) => mutation.entryId).sort()).toEqual(["entry-0", "entry-1"]);
    expect(result.hasMore).toBe(false);
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });
});
