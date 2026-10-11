import type { Plugin, TFile } from "obsidian";
import { VaultKeyCryptoService } from "../core/crypto-service";
import { TFile as ObsidianTFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { encodeUtf8, hashBytes } from "../core/content";
import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import type { SyncTokenResponse } from "../remote/client";
import { createInitializedTestSyncStore } from "../../test-support/test-plugin";
import { writeStoredSyncConnection } from "../store/connection";
import type { PullDeviceIssueEvent } from "../engine/pull-entry-state-applier";
import { DeviceSyncIssues } from "./device-sync-issues";
import { SyncEngine } from "./engine";
import { RemoteVaultKeyMismatchError } from "../../remote-vault/types";

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

  describe("resume verification status", () => {
    type LoopDeps = {
      onVerificationStarted?: () => void;
      onError?: (error: unknown) => void;
    };
    const loopDepsOf = (engine: SyncEngine): LoopDeps =>
      (engine as unknown as { syncAutoLoop: { deps: LoopDeps } }).syncAutoLoop.deps;

    it("shows checking while a resume re-verifies the server cursor", () => {
      const setSyncStatus = vi.fn();
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        setSyncStatus,
      });

      loopDepsOf(engine).onVerificationStarted?.();

      expect(setSyncStatus).toHaveBeenLastCalledWith("checking");
    });

    it("keeps an escalated attention state visible during the check", () => {
      const setSyncStatus = vi.fn();
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        setSyncStatus,
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const deps = loopDepsOf(engine);
      for (let i = 0; i < 5; i += 1) {
        deps.onError?.(new Error("server exploded"));
      }
      expect(setSyncStatus).toHaveBeenLastCalledWith("attention_needed");

      deps.onVerificationStarted?.();

      expect(setSyncStatus).not.toHaveBeenCalledWith("checking");
    });

    it("exposes the loop's last verification time", () => {
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")));

      expect(engine.getLastVerifiedAt()).toBeNull();
      engine.markVerified();
      expect(engine.getLastVerifiedAt()).toEqual(expect.any(Number));
    });
  });

  describe("activity recording", () => {
    type ActivityLoopDeps = {
      pullOnce: (session: unknown) => Promise<unknown>;
      pushPendingMutations: (session: unknown) => Promise<unknown>;
      onError?: (error: unknown) => void;
      onActivity?: (kind: string, message: string) => void;
    };
    const loopDepsOf = (engine: SyncEngine): ActivityLoopDeps =>
      (engine as unknown as { syncAutoLoop: { deps: ActivityLoopDeps } }).syncAutoLoop.deps;
    const servicesOf = (engine: SyncEngine) =>
      engine as unknown as {
        syncPullService: { pullOnce: (session: unknown) => Promise<unknown> };
        syncPushService: { pushPendingMutations: (session: unknown) => Promise<unknown> };
      };

    function createRecordingEngine() {
      const recordActivity = vi.fn();
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        recordActivity,
      });
      return { engine, recordActivity };
    }

    it("records pull results with counts and cursor", async () => {
      const { engine, recordActivity } = createRecordingEngine();
      vi.spyOn(servicesOf(engine).syncPullService, "pullOnce").mockResolvedValue({
        cursor: 12,
        entriesApplied: 3,
        filesWritten: 2,
        filesDeleted: 1,
        conflictsCreated: 0,
      });

      await loopDepsOf(engine).pullOnce({});

      expect(recordActivity).toHaveBeenCalledWith("pull", expect.stringContaining("12"));
      const message = recordActivity.mock.calls.find(([kind]) => kind === "pull")?.[1] as string;
      expect(message).toMatch(/3/);
      expect(message).toMatch(/2/);
    });

    it("records pushes that sent mutations and skips empty ones", async () => {
      const { engine, recordActivity } = createRecordingEngine();
      const push = vi.spyOn(servicesOf(engine).syncPushService, "pushPendingMutations");
      push.mockResolvedValueOnce({
        cursor: 0,
        mutationsPushed: 0,
        mutationsRequeued: 0,
        mutationsDropped: 0,
        filesCreatedOrUpdated: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        shouldPullAfterPush: false,
        hasMore: false,
      });
      await loopDepsOf(engine).pushPendingMutations({});
      expect(recordActivity).not.toHaveBeenCalledWith("push", expect.anything());

      push.mockResolvedValueOnce({
        cursor: 9,
        mutationsPushed: 4,
        mutationsRequeued: 0,
        mutationsDropped: 0,
        filesCreatedOrUpdated: 4,
        filesDeleted: 0,
        conflictsCreated: 0,
        shouldPullAfterPush: false,
        hasMore: false,
      });
      await loopDepsOf(engine).pushPendingMutations({});
      expect(recordActivity).toHaveBeenCalledWith("push", expect.stringContaining("4"));
    });

    it("records quiet and escalated errors", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { engine, recordActivity } = createRecordingEngine();

      loopDepsOf(engine).onError?.(new Error("socket hiccup"));
      expect(recordActivity).toHaveBeenLastCalledWith(
        "error",
        expect.stringContaining("socket hiccup"),
      );
      // The fifth consecutive transient error escalates.
      for (let i = 0; i < 4; i += 1) {
        loopDepsOf(engine).onError?.(new Error("server exploded"));
      }
      expect(recordActivity).toHaveBeenLastCalledWith(
        "error",
        expect.stringMatching(/escalated.*server exploded/i),
      );
    });

    it("forwards loop activity and records conflicts with paths", () => {
      const { engine, recordActivity } = createRecordingEngine();

      loopDepsOf(engine).onActivity?.("connect", "Connected");
      expect(recordActivity).toHaveBeenCalledWith("connect", "Connected");

      const conflictDeps = (engine as unknown as {
        syncPullService: { deps: { onConflict: (event: unknown) => void } };
      }).syncPullService.deps;
      conflictDeps.onConflict({
        op: "upsert",
        reason: "local_pending_mutation",
        originalPath: "notes/a.md",
        conflictPath: "notes/a (conflict).md",
      });
      expect(recordActivity).toHaveBeenCalledWith(
        "conflict",
        expect.stringContaining("notes/a.md"),
      );
    });

    it("counts pending uploads in the store", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8(""));
      const engine = createEngine(plugin);
      expect(await engine.countPendingMutations()).toBe(0);
    });
  });

  describe("queued changes encrypted with an old key", () => {
    type DropListener = { onUndecryptablePendingDropped: (mutation: unknown) => void };
    const internals = (engine: SyncEngine) =>
      engine as unknown as {
        syncPushService: { deps: DropListener };
        syncPullService: { deps: DropListener };
        syncLocalReconcileService: {
          deps: DropListener;
          reconcileOnce: (options?: unknown) => Promise<unknown>;
        };
      };

    it("logs the drops once and re-scans local files with the queue sanitized", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8(""));
      const store = await createInitializedTestSyncStore(plugin);
      const recordActivity = vi.fn();
      const engine = createEngine(plugin, { recordActivity });
      engine.setStore(store);
      const reconcile = vi
        .spyOn(internals(engine).syncLocalReconcileService, "reconcileOnce")
        .mockResolvedValue({ filesScanned: 2, filesQueuedForUpsert: 2, filesQueuedForDelete: 0 });
      const notifyLocalChange = vi.spyOn(engine, "notifyLocalChange");

      // One drop from the push, one from a pull and one from a scan, all in one go.
      internals(engine).syncPushService.deps.onUndecryptablePendingDropped({});
      internals(engine).syncPullService.deps.onUndecryptablePendingDropped({});
      internals(engine).syncLocalReconcileService.deps.onUndecryptablePendingDropped({});
      await engine.waitForLocalMutationWork();

      expect(recordActivity).toHaveBeenCalledWith(
        "scan",
        "Dropped 3 queued changes encrypted with an old key; re-scanning files",
      );
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith({ sanitizePendingMetadata: true });
      expect(notifyLocalChange).toHaveBeenCalled();
      await store.close();
    });

    it("re-scans after a stale change was re-created as a new entry", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8(""));
      const store = await createInitializedTestSyncStore(plugin);
      const recordActivity = vi.fn();
      const engine = createEngine(plugin, { recordActivity });
      engine.setStore(store);
      const reconcile = vi
        .spyOn(internals(engine).syncLocalReconcileService, "reconcileOnce")
        .mockResolvedValue({ filesScanned: 1, filesQueuedForUpsert: 1, filesQueuedForDelete: 0 });
      const resolverDeps = (
        engine as unknown as {
          syncPushService: {
            deps: { staleEntryResolver: { deps: { onEntriesDetached: (ids: string[]) => void } } };
          };
        }
      ).syncPushService.deps.staleEntryResolver.deps;

      resolverDeps.onEntriesDetached(["entry-1", "entry-2"]);
      await engine.waitForLocalMutationWork();

      expect(recordActivity).toHaveBeenCalledWith(
        "scan",
        "Re-uploading 2 files as new entries: their server entries were removed or unreadable",
      );
      expect(reconcile).toHaveBeenCalledWith({ sanitizePendingMetadata: false });
      await store.close();
    });

    it("records and announces a change blocked after repeated rejections", () => {
      const plugin = createPlugin({}, async () => encodeUtf8(""));
      const recordActivity = vi.fn();
      const notify = vi.fn();
      const engine = createEngine(plugin, { recordActivity, notify });
      const pushDeps = (
        engine as unknown as {
          syncPushService: { deps: { onMutationBlocked: (event: unknown) => void } };
        }
      ).syncPushService.deps;

      pushDeps.onMutationBlocked({
        entryId: "entry-1",
        path: "notes/a.md",
        code: "stale_revision",
        rejections: 5,
      });

      expect(recordActivity).toHaveBeenCalledWith(
        "error",
        "Stopped uploading notes/a.md: the server rejected it 5 times (stale_revision)",
      );
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("notes/a.md"));
    });
  });

  describe("blocked uploads", () => {
    it("lists blocked local changes with a readable reason and retries the rejected ones", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8(""));
      const store = await createInitializedTestSyncStore(plugin);
      const engine = createEngine(plugin);
      engine.setStore(store);
      const notifyLocalChange = vi.spyOn(engine, "notifyLocalChange");
      for (const [entryId, path, reason] of [
        ["entry-a", "notes/a.md", "repeated_rejection"],
        ["entry-b", "big.zip", "file_too_large"],
      ] as const) {
        await store.applyLocalState({
          entryId,
          path,
          blobId: `blob-${entryId}`,
          hash: `hash-${entryId}`,
          deleted: false,
          updatedAt: 1,
          localMtime: 1,
          localSize: 1,
        });
        await store.markEntryDirty({
          mutationId: `mutation-${entryId}`,
          entryId,
          op: "upsert",
          status: "blocked",
          blockedReason: reason,
          baseRevision: 0,
          blobId: `blob-${entryId}`,
          hash: `hash-${entryId}`,
          encryptedMetadata: "unused",
          createdAt: 1,
        });
      }

      expect(await engine.listBlockedUploads()).toEqual([
        { entryId: "entry-a", path: "notes/a.md", reason: "Rejected by the server repeatedly" },
        { entryId: "entry-b", path: "big.zip", reason: "Too large for the server" },
      ]);

      expect(await engine.retryBlockedUploads()).toBe(1);
      expect((await store.listDirtyEntries()).map((row) => row.entryId)).toEqual(["entry-a"]);
      expect(notifyLocalChange).toHaveBeenCalled();
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

    it("never counts or purges entries that are only unwritable on this device", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8("body"));
      const store = await createInitializedTestSyncStore(plugin);
      for (const [entryId, path] of [
        ["windows", "2026/260719 너희는 나를 누구라 하느냐?.md"],
        ["long", `Notes/${"가".repeat(85)}.md`],
        ["failed", "Notes/locked.md"],
        ["zombie", "Wiki/_retrieval/doc.md"],
      ] as const) {
        await store.applyRemoteState({
          entryId,
          path,
          revision: 1,
          blobId: `b-${entryId}`,
          hash: `h-${entryId}`,
          deleted: false,
          updatedAt: 1,
        });
      }
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: true } });
      deviceSyncIssues.applyPullEvent({
        kind: "write_failed",
        entryId: "failed",
        path: "Notes/locked.md",
        reason: "EBUSY",
      });
      const engine = createEngine(plugin, {
        deviceSyncIssues,
        getSyncFileRules: () => ({
          ...DEFAULT_SYNC_FILE_RULES,
          excludedFolders: ["Wiki/_retrieval"],
        }),
      });
      engine.setStore(store);

      expect(await engine.countExcludedRemoteEntries()).toBe(1);
      expect(await engine.purgeExcludedRemoteEntries()).toBe(1);
      expect((await store.listDirtyEntries(10)).map((m) => m.entryId)).toEqual(["zombie"]);

      await store.close();
    });
  });

  describe("vault key problems", () => {
    type KeyLoopDeps = {
      onError?: (error: unknown) => void;
      pullOnce: (session: unknown) => Promise<unknown>;
    };
    const loopOf = (engine: SyncEngine) =>
      (engine as unknown as { syncAutoLoop: { deps: KeyLoopDeps; stop: () => void } }).syncAutoLoop;
    const pullServiceOf = (engine: SyncEngine) =>
      (engine as unknown as {
        syncPullService: {
          deps: {
            onDecryptFailure: (entryId: string) => void;
            onEntryDecrypted: (entryId: string) => void;
          };
          pullOnce: (session: unknown) => Promise<unknown>;
        };
      }).syncPullService;
    const emptyPull = {
      cursor: 3,
      entriesApplied: 0,
      filesWritten: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
    };

    it("stops auto sync and asks for the password when the server refuses the key", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const onVaultKeyMismatch = vi.fn();
      const setSyncStatus = vi.fn();
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        onVaultKeyMismatch,
        setSyncStatus,
      });
      const loop = loopOf(engine);
      const stop = vi.spyOn(loop, "stop");

      loop.deps.onError?.(new RemoteVaultKeyMismatchError("vault-1"));

      expect(stop).toHaveBeenCalled();
      expect(setSyncStatus).toHaveBeenLastCalledWith("attention_needed");
      expect(onVaultKeyMismatch).toHaveBeenCalledTimes(1);
    });

    it("records undecryptable entries once per pull, coalesced, and persists them", async () => {
      const notify = vi.fn();
      const recordActivity = vi.fn();
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: false } });
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        notify,
        recordActivity,
        deviceSyncIssues,
      });
      const pull = pullServiceOf(engine);
      vi.spyOn(pull, "pullOnce").mockImplementation(async () => {
        pull.deps.onDecryptFailure("e1");
        pull.deps.onDecryptFailure("e2");
        pull.deps.onDecryptFailure("e2");
        return emptyPull;
      });

      await loopOf(engine).deps.pullOnce({});

      expect(deviceSyncIssues.getUnreadableEntryIds()).toEqual(["e1", "e2"]);
      const keyMessages = recordActivity.mock.calls.filter(([, message]) =>
        String(message).includes("can't be decrypted"),
      );
      expect(keyMessages).toEqual([["error", "2 entries can't be decrypted with this vault's key"]]);
      expect(notify).toHaveBeenCalledTimes(1);

      // Already known: no new log line or Notice on the next pull.
      await loopOf(engine).deps.pullOnce({});
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("clears an unreadable record when the entry later decrypts", () => {
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: false } });
      deviceSyncIssues.noteUnreadableEntry("e1");
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        deviceSyncIssues,
      });

      pullServiceOf(engine).deps.onEntryDecrypted("e1");

      expect(deviceSyncIssues.getUnreadableEntryCount()).toBe(0);
    });
  });

  describe("device sync issues", () => {
    const pullDepsOf = (engine: SyncEngine) =>
      (engine as unknown as {
        syncPullService: {
          deps: { onDeviceIssue: (event: PullDeviceIssueEvent) => void };
          pullOnce: (session: unknown) => Promise<unknown>;
        };
      }).syncPullService;
    const loopPullOnce = (engine: SyncEngine) =>
      (engine as unknown as {
        syncAutoLoop: { deps: { pullOnce: (session: unknown) => Promise<unknown> } };
      }).syncAutoLoop.deps.pullOnce({});
    const emptyPull = {
      cursor: 3,
      entriesApplied: 2,
      filesWritten: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
    };

    it("logs skips, shows one Notice per pull for new issues, and never needs attention", async () => {
      const notify = vi.fn();
      const setSyncStatus = vi.fn();
      const recordActivity = vi.fn();
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: true } });
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        notify,
        setSyncStatus,
        recordActivity,
        deviceSyncIssues,
      });
      const pull = pullDepsOf(engine);
      vi.spyOn(pull, "pullOnce").mockImplementation(async () => {
        pull.deps.onDeviceIssue({
          kind: "skipped",
          entryId: "a",
          path: "2026/a?.md",
          reason: 'Name not allowed on Windows (contains "?")',
        });
        pull.deps.onDeviceIssue({
          kind: "write_failed",
          entryId: "b",
          path: "2026/b.md",
          reason: "ENOENT: no such file",
        });
        return emptyPull;
      });

      await loopPullOnce(engine);

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        "Osync: 2 files couldn't be written on this device. Open sync status for details.",
      );
      expect(recordActivity).toHaveBeenCalledWith(
        "skip",
        'Not written on this device: 2026/a?.md (Name not allowed on Windows (contains "?"))',
      );
      expect(recordActivity).toHaveBeenCalledWith(
        "skip",
        "Not written on this device: 2026/b.md (ENOENT: no such file)",
      );
      expect(setSyncStatus).not.toHaveBeenCalledWith("attention_needed");
      expect(deviceSyncIssues.getUnwritablePaths().map((entry) => entry.path)).toEqual([
        "2026/a?.md",
        "2026/b.md",
      ]);

      // The same issues again are not news: no second Notice.
      await loopPullOnce(engine);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("uses the singular Notice for one file", async () => {
      const notify = vi.fn();
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        notify,
        deviceSyncIssues: new DeviceSyncIssues({ platform: { isWin: false } }),
      });
      const pull = pullDepsOf(engine);
      vi.spyOn(pull, "pullOnce").mockImplementation(async () => {
        pull.deps.onDeviceIssue({ kind: "write_failed", entryId: "b", path: "b.md", reason: "x" });
        return emptyPull;
      });

      await loopPullOnce(engine);

      expect(notify).toHaveBeenCalledWith(
        "Osync: 1 file couldn't be written on this device. Open sync status for details.",
      );
    });

    it("excludes unwritable paths from the vault adapter's syncable predicate", () => {
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: true } });
      deviceSyncIssues.applyPullEvent({
        kind: "write_failed",
        entryId: "f",
        path: "Notes/locked.md",
        reason: "EBUSY",
      });
      const engine = createEngine(createPlugin({}, async () => encodeUtf8("")), {
        deviceSyncIssues,
      });
      const adapter = (engine as unknown as {
        vaultAdapter: { isSyncablePath(path: string): boolean };
      }).vaultAdapter;

      expect(adapter.isSyncablePath("Notes/a?.md")).toBe(false);
      expect(adapter.isSyncablePath("Notes/locked.md")).toBe(false);
      expect(adapter.isSyncablePath("Notes/fine.md")).toBe(true);
    });

    it("retries failed writes by re-applying the recorded remote state", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8(""));
      const store = await createInitializedTestSyncStore(plugin);
      const body = encodeUtf8("sermon body");
      await store.applyRemoteState({
        entryId: "e",
        path: "2026/note.md",
        revision: 2,
        blobId: "blob-e",
        hash: await hashBytes(body),
        deleted: false,
        updatedAt: 1,
      });
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: false } });
      deviceSyncIssues.applyPullEvent({
        kind: "write_failed",
        entryId: "e",
        path: "2026/note.md",
        reason: "EBUSY",
      });
      const engine = createEngine(plugin, { deviceSyncIssues });
      engine.setStore(store);
      const downloads = vi
        .spyOn(engine, "downloadAndDecryptVersionBlob")
        .mockResolvedValue(body);

      const result = await engine.retryUnwritablePaths();

      expect(result).toEqual({ retried: 1, failed: 0 });
      expect(downloads).toHaveBeenCalledWith("blob-e");
      expect(await plugin.app.vault.adapter.read("2026/note.md")).toBe("sermon body");
      expect(await store.getLocalStateById("e")).toMatchObject({
        path: "2026/note.md",
        blobId: "blob-e",
        hash: await hashBytes(body),
        deleted: false,
      });
      expect(deviceSyncIssues.getUnwritablePaths()).toEqual([]);
      await store.close();
    });

    it("does not overwrite a file edited locally while its path was excluded", async () => {
      const plugin = createPlugin({}, async () => encodeUtf8(""));
      const store = await createInitializedTestSyncStore(plugin);
      await store.upsertEntry({
        entryId: "e",
        path: "note.md",
        revision: 1,
        blobId: "blob-old",
        hash: await hashBytes(encodeUtf8("old")),
        deleted: false,
        updatedAt: 1,
        localMtime: null,
        localSize: null,
      });
      await store.applyRemoteState({
        entryId: "e",
        path: "note.md",
        revision: 2,
        blobId: "blob-new",
        hash: await hashBytes(encodeUtf8("new")),
        deleted: false,
        updatedAt: 2,
      });
      await plugin.app.vault.adapter.writeBinary("note.md", encodeUtf8("edited").slice().buffer);
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: false } });
      deviceSyncIssues.applyPullEvent({ kind: "write_failed", entryId: "e", path: "note.md", reason: "x" });
      const engine = createEngine(plugin, { deviceSyncIssues });
      engine.setStore(store);
      const downloads = vi.spyOn(engine, "downloadAndDecryptVersionBlob");

      expect(await engine.retryUnwritablePaths()).toEqual({ retried: 1, failed: 0 });
      expect(downloads).not.toHaveBeenCalled();
      expect(deviceSyncIssues.getUnwritablePaths()).toEqual([]);
      await store.close();
    });

    it("keeps a path listed when the retry fails again", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const plugin = createPlugin({}, async () => encodeUtf8(""));
      const store = await createInitializedTestSyncStore(plugin);
      await store.applyRemoteState({
        entryId: "e",
        path: "note.md",
        revision: 1,
        blobId: "blob-e",
        hash: "h",
        deleted: false,
        updatedAt: 1,
      });
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: false } });
      deviceSyncIssues.applyPullEvent({ kind: "write_failed", entryId: "e", path: "note.md", reason: "x" });
      const engine = createEngine(plugin, { deviceSyncIssues });
      engine.setStore(store);
      vi.spyOn(engine, "downloadAndDecryptVersionBlob").mockRejectedValue(new Error("offline"));

      expect(await engine.retryUnwritablePaths()).toEqual({ retried: 1, failed: 1 });
      expect(deviceSyncIssues.getUnwritablePaths()).toEqual([
        expect.objectContaining({ path: "note.md", reason: "offline" }),
      ]);
      expect(await store.getLocalStateById("e")).toBeNull();
      await store.close();
    });

    it("warns once per path about local files Windows cannot open, but still uploads them", async () => {
      const notify = vi.fn();
      const recordActivity = vi.fn();
      const plugin = createPlugin({}, async () => encodeUtf8("body"));
      (plugin.app.vault.getFiles as ReturnType<typeof vi.fn>).mockReturnValue([
        createFile("2026/what?.md"),
        createFile("fine.md"),
      ]);
      const store = await createInitializedTestSyncStore(plugin);
      const deviceSyncIssues = new DeviceSyncIssues({ platform: { isWin: false } });
      const engine = createEngine(plugin, { notify, recordActivity, deviceSyncIssues });
      engine.setStore(store);

      const first = await engine.reconcileOnce();
      await engine.reconcileOnce();

      expect(first.filesQueuedForUpsert).toBe(2);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        'Osync: "what?.md" can\'t be opened on Windows (contains "?"). Rename it to sync to Windows devices.',
      );
      expect(recordActivity).toHaveBeenCalledWith(
        "warning",
        'Won\'t open on Windows: 2026/what?.md (contains "?")',
      );
      expect(deviceSyncIssues.getPortabilityWarnings()).toEqual([
        { path: "2026/what?.md", reason: 'contains "?"' },
      ]);
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
