import { describe, expect, it, vi } from "vitest";
import { VaultKeyCryptoService } from "../core/crypto-service";

import { encryptSyncMetadata } from "../core/crypto";
import type { SyncRealtimeSession } from "../remote/realtime-client";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../test-support/test-plugin";
import {
  SyncVersionHistoryService,
  type SyncVersionHistoryStore,
} from "./version-history-service";

const TEST_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

describe("SyncVersionHistoryService", () => {
  it("does not request remote history for local-only entries", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.applyLocalState({
      entryId: "entry-local",
      path: "local-only.md",
      blobId: "blob-local",
      hash: "hash-local",
      deleted: false,
      updatedAt: Date.now(),
      localMtime: null,
      localSize: null,
    });
    const withRealtimeSession = vi.fn();
    const service = createService(store, { withRealtimeSession });

    await expect(
      service.listEntryVersionsForPath("local-only.md", null, 25),
    ).resolves.toBeNull();
    expect(withRealtimeSession).not.toHaveBeenCalled();

    await store.close();
  });

  it("lists synced deleted entries from the local store", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const service = createService(store);

    await expect(service.listDeletedEntries()).resolves.toEqual([
      {
        entryId: "entry-deleted",
        path: "Folder/deleted.md",
        revision: 3,
        deletedAt: 30,
        dirty: false,
      },
    ]);

    await store.close();
  });

  it("restores deleted entries from their newest upsert version", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const versionMetadata = await encryptSyncMetadata(
      TEST_VAULT_KEY,
      {
        path: "Folder/deleted.md",
        hash: "hash-old",
      },
      {
        entryId: "entry-deleted",
        revision: 2,
        op: "upsert",
        blobId: "blob-old",
      },
    );
    const restoreEntryVersion = vi.fn(async () => ({
      entryId: "entry-deleted",
      restoredFromVersionId: "version-old",
      restoredFromRevision: 2,
      cursor: 4,
      revision: 4,
    }));
    const session = createRealtimeSession({
      listEntryVersions: async () => ({
        entryId: "entry-deleted",
        versions: [
          {
            versionId: "version-delete",
            sourceRevision: 3,
            op: "delete",
            blobId: null,
            encryptedMetadata: "delete-metadata",
            reason: "before_restore",
            capturedAt: 300,
          },
          {
            versionId: "version-old",
            sourceRevision: 2,
            op: "upsert",
            blobId: "blob-old",
            encryptedMetadata: versionMetadata,
            reason: "before_delete",
            capturedAt: 200,
          },
        ],
        hasMore: false,
        nextBefore: null,
      }),
      restoreEntryVersion,
    });
    const pullOnce = vi.fn();
    const service = createService(store, {
      pullOnce,
      withRealtimeSession: async (work) => await work(session),
    });

    await service.restoreDeletedEntry("entry-deleted");

    expect(restoreEntryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "entry-deleted",
        versionId: "version-old",
        baseRevision: 3,
        op: "upsert",
        blobId: "blob-old",
      }),
    );
    expect(pullOnce).toHaveBeenCalledWith(session);

    await store.close();
  });

  it("blocks active file version restore while the entry has local changes", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Folder/active.md",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-active",
      entryId: "entry-active",
      op: "upsert",
      baseRevision: 3,
      baseBlobId: "blob-current",
      baseHash: "hash-current",
      blobId: "blob-local",
      hash: "hash-local",
      encryptedMetadata: "local-metadata",
      createdAt: 40,
    });
    const restoreEntryVersion = vi.fn();
    const session = createRealtimeSession({ restoreEntryVersion });
    const service = createService(store, {
      withRealtimeSession: async (work) => await work(session),
    });

    await expect(
      service.restoreEntryVersionForPath(
        "Folder/active.md",
        await createEntryVersion({
          entryId: "entry-active",
          sourceRevision: 2,
          versionId: "version-old",
        }),
      ),
    ).rejects.toThrow("Sync local changes before restoring version history.");
    expect(restoreEntryVersion).not.toHaveBeenCalled();

    await store.close();
  });

  it("throws when a deleted entry has no restorable upsert version", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const restoreEntryVersion = vi.fn();
    const session = createRealtimeSession({
      listEntryVersions: async () => ({
        entryId: "entry-deleted",
        versions: [
          {
            versionId: "version-delete",
            sourceRevision: 3,
            op: "delete",
            blobId: null,
            encryptedMetadata: "delete-metadata",
            reason: "before_restore",
            capturedAt: 300,
          },
        ],
        hasMore: false,
        nextBefore: null,
      }),
      restoreEntryVersion,
    });
    const service = createService(store, {
      withRealtimeSession: async (work) => await work(session),
    });

    await expect(service.restoreDeletedEntry("entry-deleted")).rejects.toThrow(
      "No restorable version exists for this deleted file.",
    );
    expect(restoreEntryVersion).not.toHaveBeenCalled();

    await store.close();
  });

  it("restores a selected active file version and pulls the restored state", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Folder/active.md",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const restoreEntryVersion = vi.fn(async () => ({
      entryId: "entry-active",
      restoredFromVersionId: "version-old",
      restoredFromRevision: 2,
      cursor: 4,
      revision: 4,
    }));
    const session = createRealtimeSession({ restoreEntryVersion });
    const pullOnce = vi.fn();
    const service = createService(store, {
      pullOnce,
      withRealtimeSession: async (work) => await work(session),
    });

    await service.restoreEntryVersionForPath(
      "Folder/active.md",
      await createEntryVersion({
        entryId: "entry-active",
        sourceRevision: 2,
        versionId: "version-old",
      }),
    );

    expect(restoreEntryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "entry-active",
        versionId: "version-old",
        baseRevision: 3,
        op: "upsert",
        blobId: "blob-old",
      }),
    );
    expect(pullOnce).toHaveBeenCalledWith(session);

    await store.close();
  });
});

function createService(
  store: SyncVersionHistoryStore,
  overrides: Partial<ConstructorParameters<typeof SyncVersionHistoryService>[0]> = {},
): SyncVersionHistoryService {
  return new SyncVersionHistoryService({
    getStore: () => store,
    crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    withRealtimeSession: async (work) => await work(createRealtimeSession({})),
    runLocalMutationWork: async (work) => await work(),
    pullOnce: vi.fn(),
    ...overrides,
  });
}

function createRealtimeSession(
  overrides: Partial<SyncRealtimeSession>,
): SyncRealtimeSession {
  return {
    serverCursor: 0,
    storageUsedBytes: 0,
    storageLimitBytes: 100_000_000,
    maxFileSizeBytes: 3_000_000,
    watchStorageStatus: vi.fn(),
    unwatchStorageStatus: vi.fn(),
    listEntryStates: vi.fn(async () => ({
      targetCursor: 0,
      totalEntries: 0,
      hasMore: false,
      nextAfter: null,
      entries: [],
    })),
    listEntryVersions: vi.fn(),
    restoreEntryVersion: vi.fn(),
    ackCursor: vi.fn(),
    commitMutation: vi.fn(),
    commitMutations: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as SyncRealtimeSession;
}

async function createEntryVersion(input: {
  entryId: string;
  sourceRevision: number;
  versionId: string;
}): Promise<{
  versionId: string;
  sourceRevision: number;
  op: "upsert";
  blobId: string;
  encryptedMetadata: string;
  reason: "before_delete";
  capturedAt: number;
}> {
  return {
    versionId: input.versionId,
    sourceRevision: input.sourceRevision,
    op: "upsert",
    blobId: "blob-old",
    encryptedMetadata: await encryptSyncMetadata(
      TEST_VAULT_KEY,
      {
        path: "Folder/active.md",
        hash: "hash-old",
      },
      {
        entryId: input.entryId,
        revision: input.sourceRevision,
        op: "upsert",
        blobId: "blob-old",
      },
    ),
    reason: "before_delete",
    capturedAt: 200,
  };
}
