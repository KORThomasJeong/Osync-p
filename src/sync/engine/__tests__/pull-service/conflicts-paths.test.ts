import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { hashBytes } from "../../../core/content";
import { SyncPullService } from "../../pull-service";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import {
  arrangePendingUpsertWithCachedBase,
  createCommit,
  createEventGate,
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

describe("SyncPullService path conflicts", () => {
  it("adopts an unpushed local entry when the same remote path has identical content", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const body = "same body";
    const hash = await hashText(body);
    const adapter = createVaultAdapter({
      "Folder/shared.md": body,
    });
    await store.upsertEntry({
      entryId: "entry-local",
      path: "Folder/shared.md",
      revision: 0,
      blobId: "blob-local",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-local",
      entryId: "entry-local",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-local",
      hash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-local",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-local",
        path: "Folder/shared.md",
        hash,
      }),
      createdAt: 2,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-remote",
              revision: 1,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-remote",
                revision: 1,
                blobId: "blob-remote",
                path: "Folder/shared.md",
                hash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob("blob-remote", new TextEncoder().encode(body)),
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
      cursor: 2,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/shared.md")).toBe(body);
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBeNull();
    expect(await store.getEntryById("entry-local")).toBeNull();
    expect(await store.getEntryById("entry-remote")).toMatchObject({
      entryId: "entry-remote",
      path: "Folder/shared.md",
      revision: 1,
      hash,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([]);

    await store.close();
  });

  it("adopts the remote identity but preserves differing unpushed local content as a conflict copy", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const localHash = await hashText("local body");
    const remoteHash = await hashText("remote body");
    const adapter = createVaultAdapter({
      "Folder/shared.md": "local body",
    });
    await store.upsertEntry({
      entryId: "entry-local",
      path: "Folder/shared.md",
      revision: 0,
      blobId: "blob-local",
      hash: localHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-local",
      entryId: "entry-local",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-local",
      hash: localHash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-local",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-local",
        path: "Folder/shared.md",
        hash: localHash,
      }),
      createdAt: 2,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-remote",
              revision: 1,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-remote",
                revision: 1,
                blobId: "blob-remote",
                path: "Folder/shared.md",
                hash: remoteHash,
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
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 2,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/shared.md")).toBe("remote body");
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBe(
      "local body",
    );
    expect(await store.getEntryById("entry-local")).toBeNull();
    expect(await store.getEntryById("entry-remote")).toMatchObject({
      entryId: "entry-remote",
      path: "Folder/shared.md",
      revision: 1,
      hash: remoteHash,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-local",
        reason: "local_pending_mutation",
        originalPath: "Folder/shared.md",
        conflictPath: "Folder/shared.sync-conflict-20260422-101112.md",
      },
    ]);

    await store.close();
  });

  it("materializes same-path remote entries as conflict copies", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter();
    const suppressionCalls: string[][] = [];
    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-a",
              revision: 1,
              blobId: "blob-a",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-a",
                revision: 1,
                blobId: "blob-a",
                path: "Folder/shared.md",
                hash: await hashText("first body"),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "entry-b",
              revision: 1,
              blobId: "blob-b",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 1,
                blobId: "blob-b",
                path: "Folder/shared.md",
                hash: await hashText("second body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-a": await encryptTestBlob("blob-a", new TextEncoder().encode("first body")),
        "blob-b": await encryptTestBlob("blob-b", new TextEncoder().encode("second body")),
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
      cursor: 2,
      entriesApplied: 2,
      filesWritten: 2,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/shared.md")).toBe("first body");
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBe(
      "second body",
    );
    expect((await store.getEntryById("entry-a"))?.path).toBe("Folder/shared.md");
    expect((await store.getEntryById("entry-b"))?.path).toBe(
      "Folder/shared.sync-conflict-20260422-101112.md",
    );
    expect(await store.getCursor()).toBe(2);
    expect(conflicts).toEqual([
      {
        entryId: "entry-b",
        reason: "remote_path_collision",
        originalPath: "Folder/shared.md",
        conflictPath: "Folder/shared.sync-conflict-20260422-101112.md",
      },
    ]);
    expect(suppressionCalls).toEqual([
      ["Folder/shared.md", "Folder/shared.sync-conflict-20260422-101112.md"],
    ]);

    await store.close();
  });

  it("keeps pending local edits when remote path collisions are diverted", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createVaultAdapter({
      "Folder/shared.md": "local pending body",
    });
    const conflicts: PullConflictSummary[] = [];
    await store.upsertEntry({
      entryId: "entry-a",
      path: "Folder/shared.md",
      revision: 1,
      blobId: "blob-a",
      hash: "local-hash",
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-a",
      entryId: "entry-a",
      op: "upsert",
      baseRevision: 1,
      blobId: "blob-local",
      hash: "local-hash",
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-a",
        baseRevision: 1,
        op: "upsert",
        blobId: "blob-local",
        path: "Folder/shared.md",
        hash: "local-hash",
      }),
      createdAt: 2,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-b",
              revision: 1,
              blobId: "blob-b",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 1,
                blobId: "blob-b",
                path: "Folder/shared.md",
                hash: await hashText("remote body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-b": await encryptTestBlob("blob-b", new TextEncoder().encode("remote body")),
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
      cursor: 2,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/shared.md")).toBe("local pending body");
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBe(
      "remote body",
    );
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        mutationId: "mutation-a",
        entryId: "entry-a",
      },
    ]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-b",
        reason: "remote_path_collision",
        originalPath: "Folder/shared.md",
        conflictPath: "Folder/shared.sync-conflict-20260422-101112.md",
      },
    ]);

    await store.close();
  });
});
