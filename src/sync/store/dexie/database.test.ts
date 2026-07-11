import { describe, expect, it, vi } from "vitest";

import {
  cleanupOrphanSyncStores,
  syncStoreDbName,
  type IndexedDbLister,
} from "./database";

function makeLister(names: string[]): {
  lister: IndexedDbLister;
  deletedCalls: string[];
} {
  const deletedCalls: string[] = [];
  return {
    deletedCalls,
    lister: {
      listDatabases: async () => names.map((name) => ({ name })),
      deleteDatabase: vi.fn(async (name: string) => {
        deletedCalls.push(name);
      }),
    },
  };
}

describe("cleanupOrphanSyncStores", () => {
  it("deletes osync sync stores with different localVaultIds", async () => {
    const current = "local-current";
    const { lister, deletedCalls } = makeLister([
      syncStoreDbName("local-current"),
      syncStoreDbName("local-old-1"),
      syncStoreDbName("local-old-2"),
    ]);

    const result = await cleanupOrphanSyncStores(
      current,
      ["local-current", "local-old-1", "local-old-2"],
      lister,
    );

    expect(result.deleted).toEqual([
      syncStoreDbName("local-old-1"),
      syncStoreDbName("local-old-2"),
    ]);
    expect(result.failed).toEqual([]);
    expect(deletedCalls).toEqual([
      syncStoreDbName("local-old-1"),
      syncStoreDbName("local-old-2"),
    ]);
  });

  it("keeps the current store untouched", async () => {
    const current = "local-current";
    const { lister, deletedCalls } = makeLister([syncStoreDbName(current)]);

    const result = await cleanupOrphanSyncStores(current, [current], lister);

    expect(result.deleted).toEqual([]);
    expect(deletedCalls).toEqual([]);
  });

  it("ignores databases with unrelated names", async () => {
    const current = "local-current";
    const { lister, deletedCalls } = makeLister([
      syncStoreDbName(current),
      "obsidian-cache",
      "some-other-plugin-db",
      "osync:sync-store:v0:legacy", // different namespace version
    ]);

    const result = await cleanupOrphanSyncStores(current, [current], lister);

    expect(result.deleted).toEqual([]);
    expect(deletedCalls).toEqual([]);
  });

  it("reports failures without throwing", async () => {
    const current = "local-current";
    const orphan = syncStoreDbName("local-old");
    const lister: IndexedDbLister = {
      listDatabases: async () => [{ name: syncStoreDbName(current) }, { name: orphan }],
      deleteDatabase: vi.fn(async (name: string) => {
        if (name === orphan) throw new Error("permission denied");
      }),
    };

    const result = await cleanupOrphanSyncStores(current, [current, "local-old"], lister);

    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([orphan]);
  });

  it("handles missing database names gracefully", async () => {
    const current = "local-current";
    const lister: IndexedDbLister = {
      listDatabases: async () => [
        { name: syncStoreDbName(current) },
        {}, // undefined name
        { name: syncStoreDbName("local-old") },
      ],
      deleteDatabase: vi.fn(async () => {}),
    };

    const result = await cleanupOrphanSyncStores(current, ["local-old"], lister);

    expect(result.deleted).toEqual([syncStoreDbName("local-old")]);
  });

  it("never deletes stores owned by another vault sharing the IndexedDB origin", async () => {
    // Obsidian desktop shares one IndexedDB origin across all open vaults, so the
    // orphan list includes other vaults' sync stores. Only stores this vault has
    // owned may be removed.
    const current = "vaultA-current";
    const ownedByThisVault = ["vaultA-current", "vaultA-old"];
    const { lister, deletedCalls } = makeLister([
      syncStoreDbName("vaultA-current"),
      syncStoreDbName("vaultA-old"), // this vault's stale store → removable
      syncStoreDbName("vaultB-current"), // another vault's live store → must survive
      syncStoreDbName("vaultB-old"), // another vault's stale store → must survive
    ]);

    const result = await cleanupOrphanSyncStores(current, ownedByThisVault, lister);

    expect(result.deleted).toEqual([syncStoreDbName("vaultA-old")]);
    expect(deletedCalls).toEqual([syncStoreDbName("vaultA-old")]);
  });
});
