import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestPlugin } from "../../../test-support/test-plugin";
import { clearDexieSyncStore, createDexieSyncStore, isSyncStoreEmpty } from "./index";
import { SyncDexieDatabase } from "./database";
import { readLocalVaultId } from "./local-vault";

async function createPopulatedStore() {
  const plugin = createTestPlugin();
  const store = await createDexieSyncStore(plugin);
  const localVaultId = readLocalVaultId(plugin);
  await store.writeSyncConnection({
    localVaultId,
    remoteVaultId: "vault-1",
    lastPulledCursor: 8968,
  });
  await store.markEntryDirty({
    mutationId: "mutation-1",
    entryId: "entry-1",
    op: "delete",
    baseRevision: 1,
    blobId: null,
    hash: null,
    encryptedMetadata: "x",
    createdAt: 1,
  });
  return { plugin, store, localVaultId };
}

// Dexie's shared Table prototype (the one that defines clear()).
function tablePrototype(): { clear(): Promise<void> } {
  const db = new SyncDexieDatabase("osync:test:table-prototype");
  let proto: object | null = Object.getPrototypeOf(db.metadata) as object | null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "clear")) {
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  db.close();
  if (!proto) {
    throw new Error("Dexie table prototype not found");
  }
  return proto as { clear(): Promise<void> };
}

describe("clearDexieSyncStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves an empty store under the kept id", async () => {
    const { plugin, store, localVaultId } = await createPopulatedStore();
    await store.close();
    expect(await isSyncStoreEmpty(localVaultId)).toBe(false);

    const result = await clearDexieSyncStore(plugin, { preserveLocalVaultId: true });

    expect(result.verified).toBe(true);
    expect(readLocalVaultId(plugin)).toBe(localVaultId);
    const fresh = await createDexieSyncStore(plugin);
    expect(await fresh.getCursor()).toBe(0);
    expect(await fresh.listDirtyEntries()).toEqual([]);
    await fresh.close();
  });

  it("does not hang on a database delete that stays blocked", async () => {
    const { plugin, store } = await createPopulatedStore();
    await store.close();
    vi.spyOn(Dexie, "delete").mockReturnValue(new Promise<void>(() => {}) as never);

    const result = await clearDexieSyncStore(plugin, {
      preserveLocalVaultId: true,
      deleteTimeoutMs: 20,
    });

    // The in-place clear already emptied it.
    expect(result.verified).toBe(true);
  });

  it("issues a new local vault id when the old store can't be emptied", async () => {
    const { plugin, store, localVaultId } = await createPopulatedStore();
    // A broken IndexedDB connection: neither the clear nor the delete takes effect.
    vi.spyOn(Dexie, "delete").mockRejectedValue(new Error("UnknownError"));
    const clearSpy = vi
      .spyOn(tablePrototype(), "clear")
      .mockRejectedValue(new Error("Transaction aborted"));

    const result = await clearDexieSyncStore(plugin, { preserveLocalVaultId: true });
    clearSpy.mockRestore();

    expect(result.verified).toBe(false);
    expect(readLocalVaultId(plugin)).not.toBe(localVaultId);
    const fresh = await createDexieSyncStore(plugin);
    expect(await fresh.getCursor()).toBe(0);
    expect(await fresh.listDirtyEntries()).toEqual([]);
    await fresh.close();
    await store.close();
  });
});
