import { describe, expect, it } from "vitest";

import { hashBytes } from "../../../core/content";
import { VaultKeyCryptoService } from "../../../core/crypto-service";
import { SyncPullService } from "../../pull-service";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import {
  arrangePendingUpsertWithCachedBase,
  createCommit,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  ignoreProgress,
  TEST_VAULT_KEY,
  type PullConflictSummary,
} from "./helpers";

const conflictTimestamp = () => new Date(2026, 4, 1, 9, 30, 0).getTime();

describe("Pull conflict tiebreak (non-mergeable conflicts)", () => {
  it("client wins by editedAt: rebase pending mutation, save remote bytes to conflict copy", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);

    const baseBytes = new Uint8Array([0x00]);
    const localBytes = new Uint8Array([0x10, 0x11]);
    const remoteBytes = new Uint8Array([0x20, 0x21]);
    const baseHash = await hashBytes(baseBytes);
    const localHash = await hashBytes(localBytes);
    const remoteHash = await hashBytes(remoteBytes);
    const adapter = createVaultAdapter({
      "Attachments/picture.png": localBytes,
    });

    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-pic",
      path: "Attachments/picture.png",
      baseRevision: 4,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes,
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
      editedAt: 200,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 5,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 5,
              entryId: "entry-pic",
              revision: 5,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-pic",
                revision: 5,
                blobId: "blob-remote",
                path: "Attachments/picture.png",
                hash: remoteHash,
                editedAt: 100,
              }),
            }),
          ],
        },
      ],
    });
    const pullClient = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob("blob-remote", remoteBytes),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      pullClient,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await service.pullOnce(session);

    // Local content stays on disk, remote saved as a conflict copy.
    expect(adapter.bytes("Attachments/picture.png")).toEqual(localBytes);
    const remainingConflictPath = conflicts[0]?.conflictPath;
    expect(remainingConflictPath).toMatch(
      /^Attachments\/picture\.sync-conflict-\d+/,
    );
    expect(adapter.bytes(remainingConflictPath!)).toEqual(remoteBytes);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe("local_pending_mutation_wins");

    // Pending mutation rebased onto remote revision 5, retains local content.
    const pending = await store.getDirtyEntryMutation("entry-pic");
    expect(pending?.baseRevision).toBe(5);
    expect(pending?.hash).toBe(localHash);
    expect(pending?.blobId).toBe("blob-local");

    // Remote state row updated; local state row untouched.
    expect(await store.getRemoteStateById("entry-pic")).toMatchObject({
      revision: 5,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    expect(await store.getLocalStateById("entry-pic")).toMatchObject({
      blobId: "blob-local",
      hash: localHash,
    });
    await store.close();
  });

  it("server wins by editedAt: backup local bytes, write remote", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);

    const baseBytes = new Uint8Array([0x00]);
    const localBytes = new Uint8Array([0x10, 0x11]);
    const remoteBytes = new Uint8Array([0x20, 0x21]);
    const baseHash = await hashBytes(baseBytes);
    const localHash = await hashBytes(localBytes);
    const remoteHash = await hashBytes(remoteBytes);
    const adapter = createVaultAdapter({
      "Attachments/picture.png": localBytes,
    });

    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-pic",
      path: "Attachments/picture.png",
      baseRevision: 4,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes,
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
      editedAt: 100,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 5,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 5,
              entryId: "entry-pic",
              revision: 5,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-pic",
                revision: 5,
                blobId: "blob-remote",
                path: "Attachments/picture.png",
                hash: remoteHash,
                editedAt: 200,
              }),
            }),
          ],
        },
      ],
    });
    const pullClient = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob("blob-remote", remoteBytes),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      pullClient,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await service.pullOnce(session);

    // Remote bytes overwrite the original path; local backed up as conflict copy.
    expect(adapter.bytes("Attachments/picture.png")).toEqual(remoteBytes);
    const conflictPath = conflicts[0]?.conflictPath;
    expect(conflictPath).toMatch(/^Attachments\/picture\.sync-conflict-\d+/);
    expect(adapter.bytes(conflictPath!)).toEqual(localBytes);
    expect(conflicts[0]?.reason).toBe("local_pending_mutation");

    // Pending mutation cleared (server won).
    expect(await store.getDirtyEntryMutation("entry-pic")).toBeNull();
    expect(await store.getRemoteStateById("entry-pic")).toMatchObject({
      revision: 5,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    await store.close();
  });
});
