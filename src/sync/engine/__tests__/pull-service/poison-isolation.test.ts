import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptSyncMetadata } from "../../../core/crypto";
import { VaultKeyCryptoService } from "../../../core/crypto-service";
import { SyncPullService } from "../../pull-service";
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

describe("SyncPullService poison isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("quarantines an entry with undecryptable metadata and still applies the healthy entries", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter();
    const suppressionCalls: string[][] = [];

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            // Poison: ciphertext that cannot be decrypted with the vault key.
            createCommit({
              cursor: 1,
              entryId: "poison-1",
              revision: 1,
              blobId: "blob-poison",
              encryptedMetadata: "not-a-valid-ciphertext",
            }),
            // Healthy neighbor in the same page.
            createCommit({
              cursor: 2,
              entryId: "good-1",
              revision: 1,
              blobId: "blob-good",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "good-1",
                revision: 1,
                blobId: "blob-good",
                path: "Notes/good.md",
                hash: await hashText("good body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-good": await encryptTestBlob(
          "blob-good",
          new TextEncoder().encode("good body"),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
      onProgress: ignoreProgress,
    });

    // The whole pull must not throw because of one poison entry.
    await expect(service.pullOnce(session)).resolves.toBeDefined();

    // The healthy entry is applied.
    expect(adapter.text("Notes/good.md")).toBe("good body");

    await store.close();
  });

  it("quarantines a blob that downloads but fails hash verification, still applying healthy entries and advancing the cursor", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter();
    const suppressionCalls: string[][] = [];
    const decryptFailures: string[] = [];

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            // Poison: metadata promises the hash of "expected body", but the stored
            // blob decrypts to different bytes — a permanent, deterministic mismatch
            // that would re-fail on every retry and stall the pull forever.
            createCommit({
              cursor: 1,
              entryId: "poison-hash-1",
              revision: 1,
              blobId: "blob-corrupt",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "poison-hash-1",
                revision: 1,
                blobId: "blob-corrupt",
                path: "Notes/poison.md",
                hash: await hashText("expected body"),
              }),
            }),
            // Healthy neighbor in the same page.
            createCommit({
              cursor: 2,
              entryId: "good-1",
              revision: 1,
              blobId: "blob-good",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "good-1",
                revision: 1,
                blobId: "blob-good",
                path: "Notes/good.md",
                hash: await hashText("good body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        // Downloads and decrypts fine, but its content hash != metadata hash.
        "blob-corrupt": await encryptTestBlob(
          "blob-corrupt",
          new TextEncoder().encode("tampered body"),
        ),
        "blob-good": await encryptTestBlob(
          "blob-good",
          new TextEncoder().encode("good body"),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
      onProgress: ignoreProgress,
      onDecryptFailure: (entryId) => decryptFailures.push(entryId),
    });

    // A permanent blob-verification failure must NOT abort the whole pull.
    await expect(service.pullOnce(session)).resolves.toBeDefined();

    // The healthy entry is applied.
    expect(adapter.text("Notes/good.md")).toBe("good body");
    // The poison entry is not written to disk.
    expect(adapter.text("Notes/poison.md")).toBeNull();
    // The failure is surfaced as a diagnostic.
    expect(decryptFailures).toContain("poison-hash-1");
    // The cursor advances past the poison entry so it is never re-pulled.
    expect(await store.getCursor()).toBe(2);

    await store.close();
  });

  it("skips malformed entry states (no blob, no hash, a deleted file with a hash) and still applies the healthy ones", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter({ "Notes/kept.md": "kept body" });
    await store.upsertEntry({
      entryId: "bad-delete",
      path: "Notes/kept.md",
      revision: 1,
      blobId: "blob-kept",
      hash: await hashText("kept body"),
      deleted: false,
      updatedAt: 1,
    });
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 4,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "bad-no-blob",
              revision: 1,
              blobId: null,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "bad-no-blob",
                revision: 1,
                blobId: null,
                path: "Notes/no-blob.md",
                hash: await hashText("x"),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "bad-no-hash",
              revision: 1,
              blobId: "blob-no-hash",
              encryptedMetadata: await encryptSyncMetadata(
                TEST_VAULT_KEY,
                { path: "Notes/no-hash.md", hash: null },
                { entryId: "bad-no-hash", revision: 1, op: "upsert", blobId: "blob-no-hash" },
              ),
            }),
            createCommit({
              cursor: 3,
              entryId: "bad-delete",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              blobId: null,
              encryptedMetadata: await encryptSyncMetadata(
                TEST_VAULT_KEY,
                { path: "Notes/kept.md", hash: "unexpected" },
                { entryId: "bad-delete", revision: 2, op: "delete", blobId: null },
              ),
            }),
            createCommit({
              cursor: 4,
              entryId: "good-1",
              revision: 1,
              blobId: "blob-good",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "good-1",
                revision: 1,
                blobId: "blob-good",
                path: "Notes/good.md",
                hash: await hashText("good body"),
              }),
            }),
          ],
        },
      ],
    });
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      eventGate: createEventGate([]),
      pullClient: createPullClient({
        blobs: {
          "blob-good": await encryptTestBlob("blob-good", new TextEncoder().encode("good body")),
        },
      }),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({ cursor: 4 });

    expect(adapter.text("Notes/good.md")).toBe("good body");
    expect(adapter.text("Notes/kept.md")).toBe("kept body");
    expect(adapter.text("Notes/no-blob.md")).toBeNull();
    expect(adapter.text("Notes/no-hash.md")).toBeNull();
    expect(await store.getCursor()).toBe(4);
    await store.close();
  });
});
