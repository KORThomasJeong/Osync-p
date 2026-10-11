import { describe, expect, it } from "vitest";

import { VaultKeyCryptoService } from "../../../core/crypto-service";
import { encryptSyncMetadata } from "../../../core/crypto";
import type { SyncStore } from "../../../store/store";
import { SyncPullService } from "../../pull-service";
import { unreadablePlaceholderPath } from "../../unreadable-entries";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import {
  createCommit,
  createEventGate,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

// Another vault's key: what a device that restored the wrong key encrypted with.
const OTHER_VAULT_KEY = new Uint8Array(32).fill(7);

type VaultAdapter = ReturnType<typeof createVaultAdapter>;

function createService(input: {
  store: SyncStore;
  adapter: VaultAdapter;
  blobs?: Record<string, Uint8Array>;
  decryptFailures?: string[];
  decrypted?: string[];
}) {
  return new SyncPullService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => input.store,
    crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    vaultAdapter: input.adapter,
    eventGate: createEventGate([]),
    pullClient: createPullClient({ blobs: input.blobs ?? {} }),
    onProgress: ignoreProgress,
    onDecryptFailure: (entryId) => input.decryptFailures?.push(entryId),
    onEntryDecrypted: (entryId) => input.decrypted?.push(entryId),
  });
}

async function seedKnownEntry(store: SyncStore, entryId: string, path: string) {
  await store.setCursor(1);
  await store.upsertEntry({
    entryId,
    path,
    revision: 1,
    blobId: `blob-${entryId}`,
    hash: "hash-known",
    deleted: false,
    updatedAt: 1,
    localMtime: null,
    localSize: null,
  });
}

async function placeholderDelete(cursor: number, entryId: string, revision: number) {
  return createCommit({
    cursor,
    entryId,
    op: "delete",
    revision,
    baseRevision: revision - 1,
    blobId: null,
    encryptedMetadata: await encryptRemoteMetadata({
      entryId,
      revision,
      deleted: true,
      blobId: null,
      path: unreadablePlaceholderPath(entryId),
    }),
  });
}

describe("SyncPullService unreadable entries", () => {
  it("never deletes a local file because its remote entry is undecryptable", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter({ "Notes/mine.md": "my local text" });
    await seedKnownEntry(store, "entry-mine", "Notes/mine.md");
    const decryptFailures: string[] = [];

    // The server's current revision is a delete encrypted with another vault's key.
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 5,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 5,
              entryId: "entry-mine",
              op: "delete",
              revision: 2,
              blobId: null,
              encryptedMetadata: await encryptSyncMetadata(
                OTHER_VAULT_KEY,
                { path: "Notes/mine.md", hash: null },
                { entryId: "entry-mine", revision: 2, op: "delete", blobId: null },
              ),
            }),
          ],
        },
      ],
    });

    await createService({ store, adapter, decryptFailures }).pullOnce(session);

    expect(adapter.text("Notes/mine.md")).toBe("my local text");
    expect(decryptFailures).toEqual(["entry-mine"]);
    expect(await store.getCursor()).toBe(5);
    await store.close();
  });

  it("treats a removal placeholder for an entry it never had as a no-op", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter({ "Notes/other.md": "untouched" });
    const placeholder = unreadablePlaceholderPath("entry-ghost");
    adapter.files.set(placeholder, new TextEncoder().encode("must not be touched either"));

    const session = createRealtimeSession({
      pages: [{ cursor: 3, hasMore: false, commits: [await placeholderDelete(3, "entry-ghost", 2)] }],
    });

    const result = await createService({ store, adapter }).pullOnce(session);

    expect(result.filesDeleted).toBe(0);
    expect(result.filesWritten).toBe(0);
    expect([...adapter.files.keys()].sort()).toEqual(["Notes/other.md", placeholder].sort());
    expect(await store.getEntryStateById("entry-ghost")).toBeNull();
    expect(await store.getCursor()).toBe(3);
    await store.close();
  });

  it("keeps the local file and forgets the entry when a placeholder removes an entry this device knows", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter({ "Notes/mine.md": "my local text" });
    await seedKnownEntry(store, "entry-mine", "Notes/mine.md");

    const session = createRealtimeSession({
      pages: [{ cursor: 4, hasMore: false, commits: [await placeholderDelete(4, "entry-mine", 3)] }],
    });

    const result = await createService({ store, adapter }).pullOnce(session);

    // The file stays; the entry mapping is dropped so the next scan uploads it anew.
    expect(result.filesDeleted).toBe(0);
    expect(adapter.text("Notes/mine.md")).toBe("my local text");
    expect(await store.getEntryStateById("entry-mine")).toBeNull();
    expect(await store.getLocalStateByPath("Notes/mine.md")).toBeNull();
    await store.close();
  });

  it("reports entries that decrypt so a stale unreadable record can clear", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const decrypted: string[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "good",
              revision: 1,
              blobId: "blob-good",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "good",
                revision: 1,
                blobId: "blob-good",
                path: "good.md",
                hash: await hashText("ok"),
              }),
            }),
          ],
        },
      ],
    });

    await createService({
      store,
      adapter,
      decrypted,
      blobs: { "blob-good": await encryptTestBlob("blob-good", new TextEncoder().encode("ok")) },
    }).pullOnce(session);

    expect(decrypted).toEqual(["good"]);
    await store.close();
  });
});
