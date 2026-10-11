import { describe, expect, it, vi } from "vitest";

import { hashBytes } from "../../../core/content";
import { encryptSyncMetadata } from "../../../core/crypto";
import { VaultKeyCryptoService } from "../../../core/crypto-service";
import { SyncPullService } from "../../pull-service";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import {
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

const OLD_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => 200 - index));

describe("Pull with a queued local change encrypted with an old key", () => {
  it("applies the remote change, keeps the local file as a conflict copy, and drops the row", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const baseBytes = new TextEncoder().encode("base");
    const localBytes = new TextEncoder().encode("local edit");
    const remoteBytes = new TextEncoder().encode("remote edit");
    const baseHash = await hashBytes(baseBytes);
    const localHash = await hashBytes(localBytes);
    const remoteHash = await hashBytes(remoteBytes);
    const adapter = createVaultAdapter({ "notes/a.md": localBytes });

    await store.upsertEntry({
      entryId: "entry-a",
      path: "notes/a.md",
      revision: 4,
      blobId: "blob-base",
      hash: baseHash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.applyLocalState({
      entryId: "entry-a",
      path: "notes/a.md",
      blobId: "blob-local",
      hash: localHash,
      deleted: false,
      updatedAt: 2,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-old-key",
      entryId: "entry-a",
      op: "upsert",
      baseRevision: 4,
      baseBlobId: "blob-base",
      baseHash,
      blobId: "blob-local",
      hash: localHash,
      encryptedMetadata: await encryptSyncMetadata(
        OLD_VAULT_KEY,
        { path: "notes/a.md", hash: localHash },
        { entryId: "entry-a", revision: 5, op: "upsert", blobId: "blob-local" },
      ),
      createdAt: 3,
    });

    const conflicts: PullConflictSummary[] = [];
    const dropped = vi.fn();
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: { "blob-remote": await encryptTestBlob("blob-remote", remoteBytes) },
      }),
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      onUndecryptablePendingDropped: dropped,
    });

    await service.pullOnce(
      createRealtimeSession({
        pages: [
          {
            cursor: 5,
            hasMore: false,
            commits: [
              createCommit({
                cursor: 5,
                entryId: "entry-a",
                revision: 5,
                baseRevision: 4,
                blobId: "blob-remote",
                encryptedMetadata: await encryptRemoteMetadata({
                  entryId: "entry-a",
                  revision: 5,
                  blobId: "blob-remote",
                  path: "notes/a.md",
                  hash: remoteHash,
                }),
              }),
            ],
          },
        ],
      }),
    );

    expect(dropped).toHaveBeenCalledTimes(1);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(adapter.bytes("notes/a.md")).toEqual(remoteBytes);
    expect(conflicts).toHaveLength(1);
    const conflictPath = conflicts[0]?.conflictPath;
    expect(conflictPath).toMatch(/^notes\/a\.sync-conflict-/);
    // The user's content is never lost.
    expect(adapter.bytes(conflictPath!)).toEqual(localBytes);
    await store.close();
  });
});
