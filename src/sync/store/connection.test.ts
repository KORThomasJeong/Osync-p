import { describe, expect, it } from "vitest";

import {
  getOrCreateStoredLocalVaultId,
  readStoredSyncConnection,
  writeStoredSyncConnection,
} from "./connection";
import type {
  SyncConnection,
  PendingMutationRow,
  SyncEntryRow,
  SyncStore,
} from "./store";

describe("local vault id storage", () => {
  it("creates and persists a local vault id once", async () => {
    const store = createStore();

    const first = await getOrCreateStoredLocalVaultId(store, "remote-vault-a");
    const second = await getOrCreateStoredLocalVaultId(store, "remote-vault-a");

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(await readStoredSyncConnection(store)).toMatchObject({
      localVaultId: first,
      remoteVaultId: "remote-vault-a",
      lastPulledCursor: 0,
    });
  });

  it("writes and trims a stored local sync identity", async () => {
    const store = createStore();

    await writeStoredSyncConnection(store, {
      localVaultId: " local-vault-a ",
      remoteVaultId: " remote-vault-a ",
      lastPulledCursor: 12,
    });
    expect(await readStoredSyncConnection(store)).toEqual({
      localVaultId: "local-vault-a",
      remoteVaultId: "remote-vault-a",
      lastPulledCursor: 12,
    });
  });

  it("stores initialSyncMode=download on first connection", async () => {
    const store = createStore();

    const localVaultId = await getOrCreateStoredLocalVaultId(store, "remote-vault-a", "download");

    expect(await readStoredSyncConnection(store)).toMatchObject({
      localVaultId,
      remoteVaultId: "remote-vault-a",
      lastPulledCursor: 0,
      initialSyncMode: "download",
      initialSyncComplete: false,
    });
  });

  it("does not overwrite existing connection initialSyncMode on re-call", async () => {
    const store = createStore();
    const localVaultId = await getOrCreateStoredLocalVaultId(store, "remote-vault-a", "download");

    // Second call — returns early without overwriting
    await getOrCreateStoredLocalVaultId(store, "remote-vault-a", "merge");
    const conn = await readStoredSyncConnection(store);

    expect(conn?.initialSyncMode).toBe("download");
    expect(conn?.localVaultId).toBe(localVaultId);
  });
});

function createStore(): SyncStore {
  let identity: SyncConnection | null = null;
  const localVaultId = crypto.randomUUID();

  return {
    async readLocalVaultId(): Promise<string> {
      return localVaultId;
    },
    async readSyncConnection(): Promise<SyncConnection | null> {
      return identity;
    },
    async writeSyncConnection(nextIdentity: SyncConnection): Promise<void> {
      identity = {
        localVaultId: nextIdentity.localVaultId.trim(),
        remoteVaultId: nextIdentity.remoteVaultId.trim(),
        lastPulledCursor: nextIdentity.lastPulledCursor,
        initialSyncMode: nextIdentity.initialSyncMode,
        initialSyncComplete: nextIdentity.initialSyncComplete,
      };
    },
    async getEntryById(): Promise<SyncEntryRow | null> {
      return null;
    },
    async getEntryByPath(): Promise<SyncEntryRow | null> {
      return null;
    },
    async getEntryStateById() {
      return null;
    },
    async listEntries(): Promise<SyncEntryRow[]> {
      return [];
    },
    async countSyncProgress() {
      return {
        completedEntries: 0,
        totalEntries: 0,
      };
    },
    async getOrCreateEntryId(): Promise<string> {
      return "entry-id";
    },
    async upsertEntry(): Promise<void> {},
    async bulkApply(): Promise<void> {},
    async deleteEntry(): Promise<void> {},
    async getCursor(): Promise<number> {
      return 0;
    },
    async setCursor(): Promise<void> {},
    async markEntryDirty(): Promise<void> {},
    async replaceDirtyEntry(): Promise<void> {},
    async getDirtyEntryMutation(): Promise<PendingMutationRow | null> {
      return null;
    },
    async listDirtyEntries(): Promise<PendingMutationRow[]> {
      return [];
    },
    async clearDirtyEntryByMutationId(): Promise<void> {},
    async markEntryClean(): Promise<void> {},
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
  };
}
