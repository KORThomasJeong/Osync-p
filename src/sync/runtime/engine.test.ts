import type { Plugin, TFile } from "obsidian";
import { VaultKeyCryptoService } from "../core/crypto-service";
import { TFile as ObsidianTFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { encodeUtf8, hashBytes } from "../core/content";
import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import type { SyncTokenResponse } from "../remote/client";
import { createInitializedTestSyncStore } from "../../test-support/test-plugin";
import { writeStoredSyncConnection } from "../store/connection";
import { SyncEngine } from "./engine";

type VaultEventCallback = (...args: unknown[]) => void;

const TEST_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

describe("SyncEngine", () => {
  it("does not let baseline progress overwrite an active pull", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"));
    const store = await createInitializedTestSyncStore(plugin);
    await store.upsertEntry({
      entryId: "entry-synced",
      path: "synced.md",
      revision: 1,
      blobId: "blob-synced",
      hash: "hash-synced",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    const setSyncProgress = vi.fn();
    const engine = createEngine(plugin, { setSyncProgress });
    engine.setStore(store);
    const activityEngine = engine as unknown as {
      withSyncActivity<T>(kind: "pull", work: () => Promise<T>): Promise<T>;
      reportActivityProgress(progress: {
        completedEntries: number;
        totalEntries: number;
      }): void;
    };

    await activityEngine.withSyncActivity("pull", async () => {
      activityEngine.reportActivityProgress({
        completedEntries: 0,
        totalEntries: 4000,
      });
      await engine.refreshSyncProgress();
      activityEngine.reportActivityProgress({
        completedEntries: 100,
        totalEntries: 4000,
      });
    });

    expect(setSyncProgress.mock.calls.map(([progress]) => progress)).toEqual([
      {
        completedEntries: 0,
        totalEntries: 4000,
      },
      {
        completedEntries: 100,
        totalEntries: 4000,
      },
      {
        completedEntries: 1,
        totalEntries: 1,
      },
    ]);
    await store.close();
  });

  it("keeps pull progress active when overlapping local work finishes first", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"));
    const store = await createInitializedTestSyncStore(plugin);
    await store.upsertEntry({
      entryId: "entry-synced",
      path: "synced.md",
      revision: 1,
      blobId: "blob-synced",
      hash: "hash-synced",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    const setSyncProgress = vi.fn();
    const engine = createEngine(plugin, { setSyncProgress });
    engine.setStore(store);
    const activityEngine = engine as unknown as {
      withSyncActivity<T>(
        kind: "local" | "pull",
        work: () => Promise<T>,
      ): Promise<T>;
      reportActivityProgress(progress: {
        completedEntries: number;
        totalEntries: number;
      }): void;
    };
    const releaseLocal = createDeferred<void>();
    const releasePull = createDeferred<void>();

    const local = activityEngine.withSyncActivity("local", async () => {
      await releaseLocal.promise;
    });
    const pull = activityEngine.withSyncActivity("pull", async () => {
      activityEngine.reportActivityProgress({
        completedEntries: 0,
        totalEntries: 4000,
      });
      await releasePull.promise;
    });
    await nextTask();

    releaseLocal.resolve();
    await local;
    await engine.refreshSyncProgress();
    activityEngine.reportActivityProgress({
      completedEntries: 100,
      totalEntries: 4000,
    });
    releasePull.resolve();
    await pull;

    expect(setSyncProgress.mock.calls.map(([progress]) => progress)).toEqual([
      {
        completedEntries: 0,
        totalEntries: 4000,
      },
      {
        completedEntries: 100,
        totalEntries: 4000,
      },
      {
        completedEntries: 1,
        totalEntries: 1,
      },
    ]);
    await store.close();
  });

  it("serializes vault event recording behind an active reconcile", async () => {
    const firstRead = createDeferred<Uint8Array>();
    const callbacks: Partial<Record<"modify", VaultEventCallback>> = {};
    let readCalls = 0;
    const plugin = createPlugin(callbacks, async () => {
      readCalls += 1;
      if (readCalls === 1) {
        return await firstRead.promise;
      }

      return encodeUtf8("new");
    });
    const store = await createInitializedTestSyncStore(plugin);
    const engine = new SyncEngine({
      plugin,
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      invalidateSyncToken: vi.fn(),
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
      hasActiveRemoteVaultSession: () => true,
      notify: vi.fn(),
      notifyError: vi.fn(),
      notifySyncConflict: vi.fn(),
      setSyncProgress: vi.fn(),
      setSyncStatus: vi.fn(),
      setStorageStatus: vi.fn(),
    });
    engine.setStore(store);
    engine.registerVaultEvents();

    const reconcilePromise = engine.reconcileOnce();
    await nextTask();
    callbacks.modify?.(createFile("note.md"));
    await nextTask();

    expect(readCalls).toBe(1);

    firstRead.resolve(encodeUtf8("old"));
    await reconcilePromise;
    await eventually(async () => {
      expect(readCalls).toBe(2);
      const pending = await store.listDirtyEntries();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.hash).toBe(await hashBytes(encodeUtf8("new")));
    });
    await store.close();
  });

  describe("isInitialPullRequired", () => {
    it("returns false when store is not initialized", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8("body"));
      const engine = createEngine(plugin);
      expect(await engine.isInitialPullRequired()).toBe(false);
    });

    it("returns true when store is empty", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8("body"));
      const store = await createInitializedTestSyncStore(plugin);
      const engine = createEngine(plugin);
      engine.setStore(store);
      expect(await engine.isInitialPullRequired()).toBe(true);
      await store.close();
    });

    it("returns true when initialSyncMode=download and not yet complete", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8("body"));
      const store = await createInitializedTestSyncStore(plugin);
      await store.upsertEntry({
        entryId: "entry-1",
        path: "a.md",
        revision: 1,
        blobId: "b1",
        hash: "h1",
        deleted: false,
        updatedAt: 1,
        localMtime: 1,
        localSize: 1,
      });
      await writeStoredSyncConnection(store, {
        localVaultId: "lv",
        remoteVaultId: "rv",
        lastPulledCursor: 0,
        initialSyncMode: "download",
        initialSyncComplete: false,
      });
      const engine = createEngine(plugin);
      engine.setStore(store);
      expect(await engine.isInitialPullRequired()).toBe(true);
      await store.close();
    });

    it("returns false when store has entries and initialSyncComplete=true", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8("body"));
      const store = await createInitializedTestSyncStore(plugin);
      await store.upsertEntry({
        entryId: "entry-1",
        path: "a.md",
        revision: 1,
        blobId: "b1",
        hash: "h1",
        deleted: false,
        updatedAt: 1,
        localMtime: 1,
        localSize: 1,
      });
      await writeStoredSyncConnection(store, {
        localVaultId: "lv",
        remoteVaultId: "rv",
        lastPulledCursor: 0,
        initialSyncMode: "download",
        initialSyncComplete: true,
      });
      const engine = createEngine(plugin);
      engine.setStore(store);
      expect(await engine.isInitialPullRequired()).toBe(false);
      await store.close();
    });
  });

  describe("drainInFlightSync", () => {
    it("waits for an in-flight pull to finish before resolving", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8("body"));
      const engine = createEngine(plugin);
      const activityEngine = engine as unknown as {
        withSyncActivity<T>(kind: "pull", work: () => Promise<T>): Promise<T>;
        drainInFlightSync(): Promise<void>;
      };

      let releasePull: () => void = () => {};
      const pullGate = new Promise<void>((resolve) => {
        releasePull = resolve;
      });
      const pull = activityEngine.withSyncActivity("pull", async () => {
        await pullGate;
      });

      let drained = false;
      const drain = activityEngine.drainInFlightSync().then(() => {
        drained = true;
      });

      await nextTask();
      expect(drained).toBe(false); // pull still running → drain must wait

      releasePull();
      await pull;
      await drain;
      expect(drained).toBe(true);
    });
  });

  describe("purgeExcludedRemoteEntries", () => {
    it("queues delete mutations for live remote entries in excluded folders, leaving others", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8("body"));
      const store = await createInitializedTestSyncStore(plugin);
      await store.applyRemoteState({
        entryId: "keep",
        path: "Notes/keep.md",
        revision: 1,
        blobId: "b-keep",
        hash: "h-keep",
        deleted: false,
        updatedAt: 1,
      });
      await store.applyRemoteState({
        entryId: "zombie",
        path: "Wiki/_retrieval/doc.md",
        revision: 1,
        blobId: "b-zombie",
        hash: "h-zombie",
        deleted: false,
        updatedAt: 1,
      });

      const engine = createEngine(plugin, {
        getSyncFileRules: () => ({
          ...DEFAULT_SYNC_FILE_RULES,
          excludedFolders: ["Wiki/_retrieval"],
        }),
      });
      engine.setStore(store);

      const purged = await engine.purgeExcludedRemoteEntries();
      expect(purged).toBe(1);

      const dirty = await store.listDirtyEntries(10);
      expect(dirty.map((m) => m.entryId)).toEqual(["zombie"]);
      expect(dirty[0]?.op).toBe("delete");

      await store.close();
    });
  });
});

function createEngine(
  plugin: Plugin,
  overrides: Partial<SyncEngineDepsForTest> = {},
): SyncEngine {
  return new SyncEngine({
    plugin,
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    invalidateSyncToken: vi.fn(),
    crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
    hasActiveRemoteVaultSession: () => true,
    notify: vi.fn(),
    notifyError: vi.fn(),
    notifySyncConflict: vi.fn(),
    setSyncProgress: vi.fn(),
    setSyncStatus: vi.fn(),
    setStorageStatus: vi.fn(),
    ...overrides,
  });
}

type SyncEngineDepsForTest = ConstructorParameters<typeof SyncEngine>[0];

function createPlugin(
  callbacks: Partial<Record<"modify", VaultEventCallback>>,
  readBinary: () => Promise<Uint8Array>,
): Plugin {
  const localStorage = new Map<string, unknown>();
  const directories = new Set([".obsidian/plugins/osync"]);
  const files = new Map<string, string | Uint8Array>();

  return {
    manifest: {
      dir: ".obsidian/plugins/osync",
    },
    registerEvent: vi.fn(),
    app: {
      loadLocalStorage(key: string): unknown | null {
        return localStorage.get(key) ?? null;
      },
      saveLocalStorage(key: string, value: unknown | null): void {
        if (value === null) {
          localStorage.delete(key);
          return;
        }

        localStorage.set(key, value);
      },
      vault: {
        getFiles: vi.fn(() => [createFile("note.md")]),
        getAllLoadedFiles: vi.fn(() => []),
        readBinary: vi.fn(async () => toArrayBuffer(await readBinary())),
        on: vi.fn((eventName: string, callback: VaultEventCallback) => {
          if (eventName === "modify") {
            callbacks.modify = callback;
          }
          return {};
        }),
        adapter: {
          async exists(path: string): Promise<boolean> {
            return directories.has(path) || files.has(path);
          },
          async read(path: string): Promise<string> {
            const file = files.get(path);
            if (typeof file !== "string") {
              throw new Error(`missing test file: ${path}`);
            }

            return file;
          },
          async readBinary(path: string): Promise<ArrayBuffer> {
            const file = files.get(path);
            if (!(file instanceof Uint8Array)) {
              throw new Error(`missing test file: ${path}`);
            }

            return toArrayBuffer(file);
          },
          async write(path: string, value: string): Promise<void> {
            files.set(path, value);
          },
          async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
            files.set(path, new Uint8Array(value));
          },
          async remove(path: string): Promise<void> {
            files.delete(path);
          },
          async mkdir(path: string): Promise<void> {
            directories.add(path);
          },
        },
      },
    },
    async loadData(): Promise<unknown> {
      return null;
    },
    async saveData(): Promise<void> {},
  } as unknown as Plugin;
}

function createToken(): SyncTokenResponse {
  return {
    token: "sync-token",
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
  };
}

function createFile(path: string): TFile {
  const file = new ObsidianTFile(path) as TFile;
  file.stat = {
    ctime: 1,
    mtime: 1,
    size: 3,
  };
  return file;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await nextTask();
    }
  }

  throw lastError;
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
