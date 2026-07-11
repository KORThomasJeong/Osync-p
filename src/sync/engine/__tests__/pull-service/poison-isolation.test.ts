import { describe, expect, it } from "vitest";

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
});
