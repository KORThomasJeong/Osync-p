import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { SyncPullService } from "../../pull-service";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import {
  createCommit,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptPendingMetadata,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
  type PullConflictSummary,
} from "./helpers";

const conflictTimestamp = () => new Date(2026, 3, 22, 10, 11, 12).getTime();

describe("SyncPullService pending upsert conflict resolution", () => {
  it("clears a same-entry pending upsert when the pulled remote state has identical content", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const body = "same body";
    const hash = await hashText(body);
    const adapter = createVaultAdapter({
      "Folder/note.md": body,
    });
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-current",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-local-pending",
      hash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-local-pending",
        path: "Folder/note.md",
        hash,
      }),
      createdAt: 2,
    });

    const conflicts: Array<{ originalPath: string; conflictPath: string | null }> = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path: "Folder/note.md",
                hash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode(body),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 3,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/note.md")).toBe(body);
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBeNull();
    expect(conflicts).toEqual([]);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getEntryById("entry-note")).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash,
    });

    await store.close();
  });

  it("preserves current vault content when a matching pending upsert is stale", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const queuedBody = "same body";
    const currentBody = "changed after queue";
    const hash = await hashText(queuedBody);
    const adapter = createVaultAdapter({
      "Folder/note.md": currentBody,
    });
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-current",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-local-pending",
      hash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-local-pending",
        path: "Folder/note.md",
        hash,
      }),
      createdAt: 2,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path: "Folder/note.md",
                hash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode(queuedBody),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      pullClient: client,
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

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 3,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/note.md")).toBe(queuedBody);
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBe(
      currentBody,
    );
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-note",
        reason: "local_pending_mutation",
        originalPath: "Folder/note.md",
        conflictPath: "Folder/note.sync-conflict-20260422-101112.md",
      },
    ]);

    await store.close();
  });

  it("preserves pending local upserts before applying conflicting remote changes", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter({
      "Folder/note.md": "local body",
    });
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-current",
      hash: "local-hash",
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-local-pending",
      hash: "local-hash",
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-local-pending",
        path: "Folder/note.md",
        hash: "local-hash",
      }),
      createdAt: 2,
    });

    const conflicts: Array<{ originalPath: string; conflictPath: string | null }> = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path: "Folder/note.md",
                hash: await hashText("remote body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode("remote body"),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 3,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/note.md")).toBe("remote body");
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBe("local body");
    expect(conflicts).toEqual([
      {
        originalPath: "Folder/note.md",
        conflictPath: "Folder/note.sync-conflict-20260422-101112.md",
      },
    ]);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect((await store.getEntryById("entry-note"))?.revision).toBe(3);

    await store.close();
  });
  it("lets the synced config replace a config file this device created before syncing", async () => {
    // Obsidian writes default settings into a new vault before Osync connects; the
    // vault's synced settings must win instead of being pushed over.
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const localDefault = "{}";
    const remoteBody = '{"theme":"obsidian"}';
    const adapter = createVaultAdapter({ ".obsidian/appearance.json": localDefault });
    const localHash = await hashText(localDefault);
    const remoteHash = await hashText(remoteBody);
    await store.applyLocalState({
      entryId: "local-appearance",
      path: ".obsidian/appearance.json",
      blobId: "blob-local",
      hash: localHash,
      deleted: false,
      updatedAt: Date.now(),
      localMtime: 1,
      localSize: 2,
    });
    await store.markEntryDirty({
      mutationId: "mutation-local-appearance",
      entryId: "local-appearance",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-local",
      hash: localHash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "local-appearance",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-local",
        path: ".obsidian/appearance.json",
        hash: localHash,
        editedAt: Date.now(),
      }),
      createdAt: Date.now(),
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "remote-appearance",
              revision: 1,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "remote-appearance",
                revision: 1,
                blobId: "blob-remote",
                path: ".obsidian/appearance.json",
                hash: remoteHash,
                editedAt: 1,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob("blob-remote", new TextEncoder().encode(remoteBody)),
      },
    });
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      now: conflictTimestamp,
    });

    await service.pullOnce(session);

    expect(adapter.text(".obsidian/appearance.json")).toBe(remoteBody);
    // The device's blank default is dropped, not kept as a conflict copy.
    expect(adapter.text(".obsidian/appearance.sync-conflict-20260422-101112.json")).toBeNull();
    expect(await store.listDirtyEntries()).toEqual([]);
    expect((await store.getEntryByPath(".obsidian/appearance.json"))?.entryId).toBe(
      "remote-appearance",
    );

    await store.close();
  });
});

