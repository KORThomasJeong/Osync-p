import { describe, expect, it, vi } from "vitest";

import Dexie from "dexie";
import type { Plugin } from "obsidian";

import {
  clearDexieSyncStore,
  createDexieSyncStore,
  readDexieSyncStoreConnection,
} from "./dexie";
import { readLocalVaultId } from "./dexie/local-vault";
import { replacePendingMutationForEntry } from "../core/mutation-queue";

describe("DexieSyncStore", () => {
  it("creates and persists entry ids by path", async () => {
    const plugin = createPlugin();

    const firstStore = await createDexieSyncStore(plugin);
    const firstEntryId = await firstStore.getOrCreateEntryId("Notes/alpha.md");
    await firstStore.upsertEntry({
      entryId: firstEntryId,
      path: "Notes/alpha.md",
      revision: 0,
      blobId: "blob-alpha",
      hash: "hash-alpha",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    const repeatedEntryId = await firstStore.getOrCreateEntryId("Notes/alpha.md");

    expect(repeatedEntryId).toBe(firstEntryId);
    await firstStore.close();

    const reopenedStore = await createDexieSyncStore(plugin);
    const reloadedEntry = await reopenedStore.getEntryByPath("Notes/alpha.md");

    expect(reloadedEntry?.entryId).toBe(firstEntryId);
    expect(reloadedEntry?.revision).toBe(0);
    expect(reloadedEntry?.deleted).toBe(false);
    await reopenedStore.close();
  });

  it("persists entries and sync connection across reopen", async () => {
    const plugin = createPlugin();

    const store = await createDexieSyncStore(plugin);
    const localVaultId = await store.readLocalVaultId();
    await store.upsertEntry({
      entryId: "entry-1",
      path: "Notes/dexie.md",
      revision: 2,
      blobId: "blob-2",
      hash: "hash-2",
      deleted: false,
      updatedAt: 123,
      localMtime: null,
      localSize: null,
    });
    await store.writeSyncConnection({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
    await store.setCursor(9);
    await store.close();

    const reopenedStore = await createDexieSyncStore(plugin);
    expect(await reopenedStore.readLocalVaultId()).toBe(localVaultId);
    expect(await reopenedStore.getEntryByPath("Notes/dexie.md")).toMatchObject({
      path: "Notes/dexie.md",
      revision: 2,
      blobId: "blob-2",
      hash: "hash-2",
      deleted: false,
      updatedAt: 123,
    });
    expect(await reopenedStore.readSyncConnection()).toEqual({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 9,
    });
    await reopenedStore.close();
  });

  it("stores the local sync identity across reopen", async () => {
    const plugin = createPlugin();

    const firstStore = await createDexieSyncStore(plugin);
    const localVaultId = await firstStore.readLocalVaultId();
    expect(await firstStore.readSyncConnection()).toBeNull();
    await firstStore.writeSyncConnection({
      localVaultId: ` ${localVaultId} `,
      remoteVaultId: " remote-vault-1 ",
      lastPulledCursor: 0,
    });
    await firstStore.close();

    const reopenedStore = await createDexieSyncStore(plugin);
    expect(await reopenedStore.readSyncConnection()).toEqual({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
    await reopenedStore.close();
  });

  it("reads a persisted identity without creating a long-lived store", async () => {
    const plugin = createPlugin();

    expect(await readDexieSyncStoreConnection(plugin)).toBeNull();

    const store = await createDexieSyncStore(plugin);
    const localVaultId = await store.readLocalVaultId();
    await store.writeSyncConnection({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
    await store.close();

    expect(await readDexieSyncStoreConnection(plugin)).toEqual({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
  });

  it("stores cursors and pending mutations across reopen", async () => {
    const plugin = createPlugin();

    const firstStore = await createDexieSyncStore(plugin);
    const localVaultId = await firstStore.readLocalVaultId();
    await firstStore.writeSyncConnection({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
    const entryId = await firstStore.getOrCreateEntryId("Notes/beta.md");
    await firstStore.upsertEntry({
      entryId,
      path: "Notes/beta.md",
      revision: 3,
      blobId: "blob-3",
      hash: "hash-3",
      deleted: false,
      updatedAt: 123,
      localMtime: null,
      localSize: null,
    });
    await firstStore.setCursor(42);
    await firstStore.markEntryDirty({
      mutationId: "mutation-1",
      entryId,
      op: "upsert",
      baseRevision: 3,
      baseBlobId: "blob-3",
      baseHash: "hash-3",
      blobId: "blob-4",
      hash: "hash-4",
      encryptedMetadata: "ciphertext-4",
      createdAt: 500,
    });
    await firstStore.putBlob({
      blobId: "blob-3",
      hash: "hash-3",
      encryptedBytes: new Uint8Array([1, 2, 3]),
      cachedAt: 501,
    });
    await firstStore.close();

    const reopenedStore = await createDexieSyncStore(plugin);
    expect(await reopenedStore.getCursor()).toBe(42);

    const reloadedEntry = await reopenedStore.getEntryById(entryId);
    expect(reloadedEntry).toEqual({
      entryId,
      entryType: "file",
      path: "Notes/beta.md",
      revision: 3,
      blobId: "blob-3",
      hash: "hash-3",
      deleted: false,
      updatedAt: 123,
      localMtime: null,
      localSize: null,
    });

    const pending = await reopenedStore.listDirtyEntries();
    expect(pending).toEqual([
      {
        mutationId: "mutation-1",
        entryId,
        entryType: "file",
        op: "upsert",
        baseRevision: 3,
        baseBlobId: "blob-3",
        baseHash: "hash-3",
        blobId: "blob-4",
        hash: "hash-4",
        encryptedMetadata: "ciphertext-4",
        createdAt: 500,
        pathToken: null,
      },
    ]);
    expect(await reopenedStore.getBlob("blob-3")).toEqual({
      blobId: "blob-3",
      hash: "hash-3",
      encryptedBytes: new Uint8Array([1, 2, 3]),
      cachedAt: 501,
    });
    expect(await reopenedStore.getEntryStateById(entryId)).toMatchObject({
      entryId,
      remote: {
        revision: 3,
        blobId: "blob-3",
        hash: "hash-3",
      },
      base: {
        revision: 3,
        blobId: "blob-3",
        hash: "hash-3",
      },
      local: {
        blobId: "blob-3",
        hash: "hash-3",
      },
      dirty: {
        mutationId: "mutation-1",
        baseBlobId: "blob-3",
        blobId: "blob-4",
      },
    });

    await reopenedStore.clearDirtyEntryByMutationId("mutation-1");
    expect(await reopenedStore.listDirtyEntries()).toEqual([]);
    await reopenedStore.close();
  });

  it("lists pending mutations by indexed queue order and clears by mutation id", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    for (const input of [
      { mutationId: "mutation-late", entryId: "entry-late", createdAt: 30 },
      { mutationId: "mutation-early", entryId: "entry-early", createdAt: 10 },
      { mutationId: "mutation-middle", entryId: "entry-middle", createdAt: 20 },
    ]) {
      await store.markEntryDirty({
        mutationId: input.mutationId,
        entryId: input.entryId,
        op: "delete",
        baseRevision: 1,
        blobId: null,
        hash: null,
        encryptedMetadata: `ciphertext-${input.mutationId}`,
        createdAt: input.createdAt,
      });
    }

    expect((await store.listDirtyEntries(2)).map((entry) => entry.mutationId)).toEqual([
      "mutation-early",
      "mutation-middle",
    ]);

    await store.clearDirtyEntryByMutationId("mutation-middle");

    expect((await store.listDirtyEntries()).map((entry) => entry.mutationId)).toEqual([
      "mutation-early",
      "mutation-late",
    ]);
    await store.close();
  });

  it("keeps the current dirty mutation when replacement base validation fails", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await store.upsertEntry({
      entryId: "entry-1",
      path: "Notes/base.md",
      revision: 3,
      blobId: "blob-3",
      hash: "hash-3",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-existing",
      entryId: "entry-1",
      op: "upsert",
      baseRevision: 3,
      baseBlobId: "blob-3",
      baseHash: "hash-3",
      blobId: "blob-existing",
      hash: "hash-existing",
      encryptedMetadata: "ciphertext-existing",
      createdAt: 2,
    });

    await expect(
      replacePendingMutationForEntry(store, {
        entryId: "entry-1",
        op: "upsert",
        baseRevision: 3,
        baseBlobId: "blob-missing",
        baseHash: "hash-missing",
        blobId: "blob-next",
        hash: "hash-next",
        encryptedMetadata: "ciphertext-next",
        createdAt: 3,
        requireBaseBlob: true,
      }),
    ).rejects.toThrow("requires cached base blob blob-missing");

    expect(await store.getDirtyEntryMutation("entry-1")).toMatchObject({
      mutationId: "mutation-existing",
      blobId: "blob-existing",
      hash: "hash-existing",
    });
    await store.close();
  });

  it("counts progress without materializing store rows", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await store.upsertEntry({
      entryId: "entry-synced",
      path: "Notes/synced.md",
      revision: 2,
      blobId: "blob-synced",
      hash: "hash-synced",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-pending",
      path: "Notes/pending.md",
      revision: 3,
      blobId: "blob-pending",
      hash: "hash-pending",
      deleted: false,
      updatedAt: 2,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-new",
      path: "Notes/new.md",
      revision: 0,
      blobId: "blob-new",
      hash: "hash-new",
      deleted: false,
      updatedAt: 3,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: null,
      revision: 4,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 4,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-delete-pending",
      path: null,
      revision: 5,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 5,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-pending",
      entryId: "entry-pending",
      op: "upsert",
      baseRevision: 3,
      blobId: "blob-pending-next",
      hash: "hash-pending-next",
      encryptedMetadata: "ciphertext-pending",
      createdAt: 10,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete-pending",
      entryId: "entry-delete-pending",
      op: "delete",
      baseRevision: 5,
      blobId: null,
      hash: null,
      encryptedMetadata: "ciphertext-delete-pending",
      createdAt: 11,
    });

    expect(await store.countSyncProgress()).toEqual({
      completedEntries: 1,
      totalEntries: 4,
    });
    await store.close();
  });

  it("lists synced deleted entries without treating tombstone paths as owners", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Notes/deleted.md",
      revision: 4,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 40,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete",
      entryId: "entry-deleted",
      op: "delete",
      baseRevision: 4,
      blobId: null,
      hash: null,
      encryptedMetadata: "ciphertext-delete",
      createdAt: 50,
    });

    expect(await store.getEntryByPath("Notes/deleted.md")).toBeNull();
    expect(await store.getOrCreateEntryId("Notes/deleted.md")).not.toBe(
      "entry-deleted",
    );
    expect(await store.listDeletedEntries()).toEqual([
      {
        entryId: "entry-deleted",
        path: "Notes/deleted.md",
        revision: 4,
        deletedAt: 40,
        dirty: true,
      },
    ]);

    await store.close();
  });

  it("deletes the persisted sync database and stored connection", async () => {
    const plugin = createPlugin();
    const firstStore = await createDexieSyncStore(plugin);
    const localVaultId = await firstStore.readLocalVaultId();
    await firstStore.upsertEntry({
      entryId: "entry-1",
      path: "Notes/reset.md",
      revision: 2,
      blobId: "blob-2",
      hash: "hash-2",
      deleted: false,
      updatedAt: 123,
      localMtime: null,
      localSize: null,
    });
    await firstStore.writeSyncConnection({
      localVaultId,
      remoteVaultId: "remote-vault-reset",
      lastPulledCursor: 0,
    });
    await firstStore.setCursor(9);
    await firstStore.close();

    await clearDexieSyncStore(plugin);

    const resetStore = await createDexieSyncStore(plugin);
    expect(await resetStore.listEntries()).toEqual([]);
    expect(await resetStore.getCursor()).toBe(0);
    expect(await resetStore.readSyncConnection()).toBeNull();
    await resetStore.close();
  });

  it("invokes corruption listener on Dexie ConstraintError", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    const events: Array<{ entryId: string; kind: string }> = [];
    store.setCorruptionListener((event) => {
      events.push({ entryId: event.entryId, kind: event.kind });
    });

    // Insert first entry claiming path "notes/foo.md"
    await store.applyRemoteState({
      entryId: "entry-1",
      path: "notes/foo.md",
      revision: 1,
      blobId: "blob-1",
      hash: "hash-1",
      deleted: false,
      updatedAt: 1,
    });

    // A different entryId claiming the SAME remote path → ConstraintError
    await expect(
      store.applyRemoteState({
        entryId: "entry-2",
        path: "notes/foo.md",
        revision: 1,
        blobId: "blob-2",
        hash: "hash-2",
        deleted: false,
        updatedAt: 2,
      }),
    ).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("constraint_error");
    expect(events[0]?.entryId).toBe("entry-2");

    await store.close();
  });
});

describe("DexieSyncStore.bulkApply", () => {
  it("is a no-op when given an empty array", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await expect(store.bulkApply([])).resolves.toBeUndefined();
    expect(await store.listEntries()).toEqual([]);

    await store.close();
  });

  it("applies a mix of upsert and applyRemote ops in one call", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await store.bulkApply([
      {
        kind: "upsert",
        entry: {
          entryId: "entry-upsert",
          path: "Notes/upsert.md",
          revision: 1,
          blobId: "blob-upsert",
          hash: "hash-upsert",
          deleted: false,
          updatedAt: 100,
          localMtime: 9_000,
          localSize: 16,
        },
      },
      {
        kind: "applyRemote",
        entry: {
          entryId: "entry-remote",
          path: "Notes/remote.md",
          revision: 2,
          blobId: "blob-remote",
          hash: "hash-remote",
          deleted: false,
          updatedAt: 200,
        },
      },
    ]);

    const upserted = await store.getEntryById("entry-upsert");
    expect(upserted).toMatchObject({
      entryId: "entry-upsert",
      path: "Notes/upsert.md",
      revision: 1,
      blobId: "blob-upsert",
      hash: "hash-upsert",
      deleted: false,
      updatedAt: 100,
      localMtime: 9_000,
      localSize: 16,
    });

    const remoteState = await store.getRemoteStateById("entry-remote");
    expect(remoteState).toMatchObject({
      entryId: "entry-remote",
      path: "Notes/remote.md",
      revision: 2,
      blobId: "blob-remote",
      hash: "hash-remote",
      deleted: false,
      updatedAt: 200,
    });

    // applyRemoteState only refreshes the remote tracking columns — no
    // local row should be created via bulkApply for an applyRemote op.
    expect(await store.getLocalStateById("entry-remote")).toBeNull();

    await store.close();
  });

  it("collapses duplicate entryIds — last op wins for that entryId", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await store.bulkApply([
      {
        kind: "applyRemote",
        entry: {
          entryId: "entry-dup",
          path: "Notes/first.md",
          revision: 1,
          blobId: "blob-first",
          hash: "hash-first",
          deleted: false,
          updatedAt: 10,
        },
      },
      {
        kind: "applyRemote",
        entry: {
          entryId: "entry-dup",
          path: "Notes/second.md",
          revision: 2,
          blobId: "blob-second",
          hash: "hash-second",
          deleted: false,
          updatedAt: 20,
        },
      },
    ]);

    expect(await store.getRemoteStateById("entry-dup")).toMatchObject({
      path: "Notes/second.md",
      revision: 2,
      blobId: "blob-second",
      hash: "hash-second",
      updatedAt: 20,
    });

    await store.close();
  });

  it("preserves copyRemoteToBase for non-dirty existing records", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    // Seed an existing remote-only row (revision 0) so copyRemoteToBase has
    // something to mirror through bulkApply.
    await store.applyRemoteState({
      entryId: "entry-base",
      path: "Notes/base.md",
      revision: 1,
      blobId: "blob-old",
      hash: "hash-old",
      deleted: false,
      updatedAt: 1,
    });

    await store.bulkApply([
      {
        kind: "applyRemote",
        entry: {
          entryId: "entry-base",
          path: "Notes/base.md",
          revision: 5,
          blobId: "blob-new",
          hash: "hash-new",
          deleted: false,
          updatedAt: 50,
        },
      },
    ]);

    const state = await store.getEntryStateById("entry-base");
    expect(state?.remote).toMatchObject({
      revision: 5,
      blobId: "blob-new",
      hash: "hash-new",
    });
    // base must have been refreshed because the row had no pending dirty mutation
    expect(state?.base).toMatchObject({
      revision: 5,
      blobId: "blob-new",
      hash: "hash-new",
    });

    await store.close();
  });

  it("yields the same end state as N single-call equivalents", async () => {
    const pluginA = createPlugin();
    const pluginB = createPlugin();
    const serialStore = await createDexieSyncStore(pluginA);
    const bulkStore = await createDexieSyncStore(pluginB);

    type Op =
      | { kind: "upsert"; entry: Parameters<typeof serialStore.upsertEntry>[0] }
      | {
          kind: "applyRemote";
          entry: Parameters<typeof serialStore.applyRemoteState>[0];
        };
    const ops: Op[] = [];
    for (let i = 0; i < 100; i++) {
      const entryId = `entry-${i}`;
      if (i % 2 === 0) {
        ops.push({
          kind: "upsert",
          entry: {
            entryId,
            path: `Notes/upsert-${i}.md`,
            revision: i + 1,
            blobId: `blob-${i}`,
            hash: `hash-${i}`,
            deleted: false,
            updatedAt: 1_000 + i,
            localMtime: null,
            localSize: null,
          },
        });
      } else {
        ops.push({
          kind: "applyRemote",
          entry: {
            entryId,
            path: `Notes/remote-${i}.md`,
            revision: i + 1,
            blobId: `blob-${i}`,
            hash: `hash-${i}`,
            deleted: false,
            updatedAt: 1_000 + i,
          },
        });
      }
    }

    for (const op of ops) {
      if (op.kind === "upsert") {
        await serialStore.upsertEntry(op.entry);
      } else {
        await serialStore.applyRemoteState(op.entry);
      }
    }

    await bulkStore.bulkApply(ops);

    const serialEntries = await serialStore.listEntries();
    const bulkEntries = await bulkStore.listEntries();
    expect(bulkEntries).toEqual(serialEntries);

    await serialStore.close();
    await bulkStore.close();
  });
});

describe("clearDexieSyncStore robustness", () => {
  it("resolves successfully and clears localVaultId when Dexie.delete throws", async () => {
    const plugin = createPlugin();

    // Seed a localVaultId by initializing a store.
    const store = await createDexieSyncStore(plugin);
    await store.close();
    // readLocalVaultId returns "" when unset, a non-empty string when set.
    expect(readLocalVaultId(plugin)).not.toBe("");

    const spy = vi
      .spyOn(Dexie, "delete")
      .mockRejectedValueOnce(new Error("locked"));
    try {
      // Mobile Obsidian can throw a DOMException ("operation-specific reason")
      // from Dexie.delete; reset must still succeed visibly so the user isn't
      // left staring at a generic failure toast. Tables are cleared in place
      // before the delete attempt, and clearLocalVaultId always runs.
      await expect(clearDexieSyncStore(plugin)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    expect(readLocalVaultId(plugin)).toBe("");
  });
});

type TestPlugin = Plugin & {
  localStorageValues: Map<string, unknown>;
};

function createPlugin(): TestPlugin {
  const localStorageValues = new Map<string, unknown>();

  return {
    manifest: {
      dir: ".obsidian/plugins/osync",
    },
    app: {
      loadLocalStorage(key: string): unknown | null {
        return localStorageValues.get(key) ?? null;
      },
      saveLocalStorage(key: string, value: unknown | null): void {
        if (value === null) {
          localStorageValues.delete(key);
          return;
        }

        localStorageValues.set(key, value);
      },
    },
    async loadData(): Promise<unknown> {
      return null;
    },
    async saveData(_value: unknown): Promise<void> {
      throw new Error("dexie sync store should not write plugin data");
    },
    localStorageValues,
  } as unknown as TestPlugin;
}
