import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncTokenResponse } from "../remote/client";
import { createTestPlugin } from "../../test-support/test-plugin";
import { SyncHttpError } from "../../http/request";
import { MassDeleteGuardError } from "../engine/mass-delete-guard";
import { SyncController } from "./controller";
import { VaultKeyCryptoService } from "../core/crypto-service";
import { SyncEngine } from "./engine";
import type { DeviceSyncIssues } from "./device-sync-issues";
import { RemoteVaultKeyMismatchError } from "../../remote-vault/types";

describe("SyncController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules a push on startup when persisted pending mutations remain", async () => {
    vi.spyOn(SyncEngine.prototype, "runInitialPullIfRequired").mockResolvedValue();
    vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(true);
    const startAutoSync = vi
      .spyOn(SyncEngine.prototype, "startAutoSync")
      .mockResolvedValue(true);
    const notifyLocalChange = vi
      .spyOn(SyncEngine.prototype, "notifyLocalChange")
      .mockImplementation(() => {});

    const controller = new SyncController(createDeps());

    await controller.ensureAutoSyncState();

    expect(startAutoSync).toHaveBeenCalledTimes(1);
    expect(notifyLocalChange).toHaveBeenCalledTimes(1);
    expect(startAutoSync.mock.invocationCallOrder[0]).toBeLessThan(
      notifyLocalChange.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not schedule a startup push when reconcile found no changes and nothing is pending", async () => {
    vi.spyOn(SyncEngine.prototype, "runInitialPullIfRequired").mockResolvedValue();
    vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(false);
    vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(true);
    const notifyLocalChange = vi
      .spyOn(SyncEngine.prototype, "notifyLocalChange")
      .mockImplementation(() => {});

    const controller = new SyncController(createDeps());

    await controller.ensureAutoSyncState();

    expect(notifyLocalChange).toHaveBeenCalledTimes(0);
  });

  it("resumes an already active auto sync loop without forcing reconnect", async () => {
    vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
    vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(false);
    const resumeAutoSyncConnection = vi
      .spyOn(SyncEngine.prototype, "resumeAutoSyncConnection")
      .mockResolvedValue();
    const reconnectAutoSync = vi
      .spyOn(SyncEngine.prototype, "reconnectAutoSync")
      .mockImplementation(() => {});

    const controller = new SyncController(createDeps());

    await controller.resumeAutoSync();

    expect(resumeAutoSyncConnection).toHaveBeenCalledTimes(1);
    expect(reconnectAutoSync).not.toHaveBeenCalled();
  });

  it("calls runInitialPullIfRequired before reconcileOnce", async () => {
    const order: string[] = [];
    vi.spyOn(SyncEngine.prototype, "runInitialPullIfRequired").mockImplementation(async () => {
      order.push("pull");
    });
    vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockImplementation(async () => {
      order.push("reconcile");
      return { filesScanned: 0, filesQueuedForUpsert: 0, filesQueuedForDelete: 0 };
    });
    vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(false);
    vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(true);

    const controller = new SyncController(createDeps());
    await controller.ensureAutoSyncState();

    expect(order).toEqual(["pull", "reconcile"]);
  });

  it("calls notifyMassDeleteGuard and sets attention_needed when reconcile trips the guard", async () => {
    vi.spyOn(SyncEngine.prototype, "runInitialPullIfRequired").mockResolvedValue();
    vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockRejectedValue(
      new MassDeleteGuardError({ deleteCount: 100, knownEntryCount: 200 }),
    );
    const startAutoSync = vi
      .spyOn(SyncEngine.prototype, "startAutoSync")
      .mockResolvedValue(true);
    const notifyMassDeleteGuard = vi.fn();

    const controller = new SyncController(createDeps({ notifyMassDeleteGuard }));
    await controller.ensureAutoSyncState();

    expect(notifyMassDeleteGuard).toHaveBeenCalledWith({
      deleteCount: 100,
      knownEntryCount: 200,
    });
    expect(controller.getSyncState()).toBe("attention_needed");
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("stays reconnecting and does not notify when initialization fails transiently (offline)", async () => {
    vi.spyOn(SyncEngine.prototype, "runInitialPullIfRequired").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const startAutoSync = vi
      .spyOn(SyncEngine.prototype, "startAutoSync")
      .mockResolvedValue(true);
    const notifyError = vi.fn();

    const controller = new SyncController(createDeps({ notifyError }));
    await controller.ensureAutoSyncState();

    expect(controller.getSyncState()).toBe("reconnecting");
    expect(notifyError).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("sets attention_needed and notifies when initialization fails actionably (401)", async () => {
    vi.spyOn(SyncEngine.prototype, "runInitialPullIfRequired").mockRejectedValue(
      new SyncHttpError(401, "unauthorized"),
    );
    const notifyError = vi.fn();

    const controller = new SyncController(createDeps({ notifyError }));
    await controller.ensureAutoSyncState();

    expect(controller.getSyncState()).toBe("attention_needed");
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith(
      expect.any(SyncHttpError),
      "Auto sync initialization failed",
    );
  });

  it("stops and hands off to the password prompt when the server refuses the vault key", async () => {
    vi.spyOn(SyncEngine.prototype, "runInitialPullIfRequired").mockRejectedValue(
      new RemoteVaultKeyMismatchError("vault-1"),
    );
    const stopAutoSync = vi.spyOn(SyncEngine.prototype, "stopAutoSync");
    const notifyError = vi.fn();
    const onVaultKeyMismatch = vi.fn();

    const controller = new SyncController(createDeps({ notifyError, onVaultKeyMismatch }));
    await controller.ensureAutoSyncState();

    expect(controller.getSyncState()).toBe("attention_needed");
    expect(stopAutoSync).toHaveBeenCalled();
    expect(onVaultKeyMismatch).toHaveBeenCalledTimes(1);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("starts auto sync on resume when the loop is not active", async () => {
    vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
    const startAutoSync = vi
      .spyOn(SyncEngine.prototype, "startAutoSync")
      .mockResolvedValue(true);
    const resumeAutoSyncConnection = vi
      .spyOn(SyncEngine.prototype, "resumeAutoSyncConnection")
      .mockResolvedValue();

    const controller = new SyncController(createDeps());

    await controller.resumeAutoSync();

    expect(startAutoSync).toHaveBeenCalledTimes(1);
    expect(resumeAutoSyncConnection).not.toHaveBeenCalled();
  });

  describe("startup retry after a transient failure", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function mockStartupPipeline() {
      const runInitialPull = vi
        .spyOn(SyncEngine.prototype, "runInitialPullIfRequired")
        .mockRejectedValue(new TypeError("Failed to fetch"));
      vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
        filesScanned: 0,
        filesQueuedForUpsert: 0,
        filesQueuedForDelete: 0,
      });
      vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(false);
      const startAutoSync = vi
        .spyOn(SyncEngine.prototype, "startAutoSync")
        .mockResolvedValue(true);
      return { runInitialPull, startAutoSync };
    }

    it("retries initialization on its own after 5s and starts once online", async () => {
      vi.useFakeTimers();
      const { runInitialPull, startAutoSync } = mockStartupPipeline();
      const controller = new SyncController(createDeps());

      await controller.ensureAutoSyncState();
      expect(runInitialPull).toHaveBeenCalledTimes(1);

      runInitialPull.mockResolvedValue();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(runInitialPull).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(runInitialPull).toHaveBeenCalledTimes(2);
      expect(startAutoSync).toHaveBeenCalledTimes(1);

      // A successful start ends the retry loop.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(runInitialPull).toHaveBeenCalledTimes(2);
    });

    it("backs off exponentially up to 60s", async () => {
      vi.useFakeTimers();
      const { runInitialPull } = mockStartupPipeline();
      const controller = new SyncController(createDeps());

      await controller.ensureAutoSyncState();
      const expectedDelays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
      for (const [index, delay] of expectedDelays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(runInitialPull).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(runInitialPull).toHaveBeenCalledTimes(index + 2);
      }
      await controller.stop();
    });

    it("cancels the pending retry on stop", async () => {
      vi.useFakeTimers();
      const { runInitialPull } = mockStartupPipeline();
      const controller = new SyncController(createDeps());

      await controller.ensureAutoSyncState();
      await controller.stop();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(runInitialPull).toHaveBeenCalledTimes(1);
    });

    it("cancels the pending retry when auto sync is marked not ready", async () => {
      vi.useFakeTimers();
      const { runInitialPull } = mockStartupPipeline();
      const controller = new SyncController(createDeps());

      await controller.ensureAutoSyncState();
      controller.stopAutoSyncAndMarkNotReady();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(runInitialPull).toHaveBeenCalledTimes(1);
    });

    it("keeps a user pause in place when the retry starts sync", async () => {
      vi.useFakeTimers();
      const { runInitialPull } = mockStartupPipeline();
      const pauseAutoSync = vi
        .spyOn(SyncEngine.prototype, "pauseAutoSync")
        .mockImplementation(() => {});
      const controller = new SyncController(createDeps());

      await controller.ensureAutoSyncState();
      // plugin-controller pauses right after the (failed) startup when sync is paused.
      controller.pauseAutoSync();
      pauseAutoSync.mockClear();

      runInitialPull.mockResolvedValue();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(pauseAutoSync).toHaveBeenCalledTimes(1);
    });

    it("runs the full initialization on resume while a startup retry is pending", async () => {
      vi.useFakeTimers();
      const { runInitialPull, startAutoSync } = mockStartupPipeline();
      vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
      const controller = new SyncController(createDeps());

      await controller.ensureAutoSyncState();
      runInitialPull.mockResolvedValue();
      await controller.resumeAutoSync();

      expect(runInitialPull).toHaveBeenCalledTimes(2);
      expect(startAutoSync).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(runInitialPull).toHaveBeenCalledTimes(2);
    });
  });

  describe("resume reconcile", () => {
    function mockResume(reconcileResult: {
      filesQueuedForUpsert: number;
      filesQueuedForDelete: number;
    }) {
      vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(false);
      vi.spyOn(SyncEngine.prototype, "resumeAutoSyncConnection").mockResolvedValue();
      vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(false);
      const reconcileOnce = vi
        .spyOn(SyncEngine.prototype, "reconcileOnce")
        .mockResolvedValue({ filesScanned: 3, ...reconcileResult });
      const notifyLocalChange = vi
        .spyOn(SyncEngine.prototype, "notifyLocalChange")
        .mockImplementation(() => {});
      return { reconcileOnce, notifyLocalChange };
    }

    it("queues files changed outside Obsidian while backgrounded", async () => {
      const { reconcileOnce, notifyLocalChange } = mockResume({
        filesQueuedForUpsert: 1,
        filesQueuedForDelete: 0,
      });
      const controller = new SyncController(createDeps());

      await controller.resumeAutoSync();

      expect(reconcileOnce).toHaveBeenCalledTimes(1);
      expect(notifyLocalChange).toHaveBeenCalledTimes(1);
    });

    it("does not schedule a push when the resume reconcile found nothing", async () => {
      const { reconcileOnce, notifyLocalChange } = mockResume({
        filesQueuedForUpsert: 0,
        filesQueuedForDelete: 0,
      });
      const controller = new SyncController(createDeps());

      await controller.resumeAutoSync();

      expect(reconcileOnce).toHaveBeenCalledTimes(1);
      expect(notifyLocalChange).not.toHaveBeenCalled();
    });

    it("throttles the reconcile scan across rapid resumes (e.g. window focus)", async () => {
      vi.useFakeTimers();
      const { reconcileOnce } = mockResume({
        filesQueuedForUpsert: 0,
        filesQueuedForDelete: 0,
      });
      const controller = new SyncController(createDeps());

      await controller.resumeAutoSync();
      await controller.resumeAutoSync();
      expect(reconcileOnce).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(30_000);
      await controller.resumeAutoSync();
      expect(reconcileOnce).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it("surfaces the mass-delete guard instead of throwing", async () => {
      const { reconcileOnce } = mockResume({
        filesQueuedForUpsert: 0,
        filesQueuedForDelete: 0,
      });
      reconcileOnce.mockRejectedValue(
        new MassDeleteGuardError({ deleteCount: 100, knownEntryCount: 200 }),
      );
      const notifyMassDeleteGuard = vi.fn();
      const controller = new SyncController(createDeps({ notifyMassDeleteGuard }));

      await expect(controller.resumeAutoSync()).resolves.toBeUndefined();

      expect(notifyMassDeleteGuard).toHaveBeenCalledWith({
        deleteCount: 100,
        knownEntryCount: 200,
      });
      expect(controller.getSyncState()).toBe("attention_needed");
    });
  });

  it("schedules a push for mutations recorded while paused when resuming from pause", async () => {
    vi.spyOn(SyncEngine.prototype, "resumeAutoSyncFromPause").mockImplementation(() => {});
    vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(true);
    const notifyLocalChange = vi
      .spyOn(SyncEngine.prototype, "notifyLocalChange")
      .mockImplementation(() => {});
    const controller = new SyncController(createDeps());

    controller.resumeAutoSyncFromPause();

    await vi.waitFor(() => expect(notifyLocalChange).toHaveBeenCalledTimes(1));
  });

  describe("activity log", () => {
    function createStorage() {
      let value: string | null = null;
      return {
        load: () => value,
        save: (json: string) => {
          value = json;
        },
      };
    }
    const recordOn = (controller: SyncController, kind: string, message: string) =>
      (controller as unknown as {
        activityLog: { record(kind: string, message: string): void };
      }).activityLog.record(kind, message);

    it("exposes, notifies and clears the activity log", () => {
      const controller = new SyncController(createDeps());
      const listener = vi.fn();
      const unsubscribe = controller.onActivityLogChange(listener);

      recordOn(controller, "connect", "Connected");

      expect(controller.getActivityLog().at(-1)).toEqual(
        expect.objectContaining({ kind: "connect", message: "Connected" }),
      );
      expect(listener).toHaveBeenCalledTimes(1);

      controller.clearActivityLog();
      expect(controller.getActivityLog()).toEqual([]);
      unsubscribe();
      recordOn(controller, "connect", "Connected");
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("keeps the log across a restart through the storage port", async () => {
      const activityLogStorage = createStorage();
      const first = new SyncController(createDeps({ activityLogStorage }));
      recordOn(first, "disconnect", "Socket closed");
      await first.stop();

      const second = new SyncController(createDeps({ activityLogStorage }));
      expect(second.getActivityLog()).toEqual([
        expect.objectContaining({ kind: "disconnect", message: "Socket closed" }),
      ]);
    });

    it("logs the resume scan results", async () => {
      vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(false);
      vi.spyOn(SyncEngine.prototype, "resumeAutoSyncConnection").mockResolvedValue();
      vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
        filesScanned: 10,
        filesQueuedForUpsert: 2,
        filesQueuedForDelete: 1,
      });
      vi.spyOn(SyncEngine.prototype, "notifyLocalChange").mockImplementation(() => {});
      const controller = new SyncController(createDeps());

      await controller.resumeAutoSync();

      const scan = controller.getActivityLog().find((entry) => entry.kind === "scan");
      expect(scan?.message).toContain("2 upserts");
      expect(scan?.message).toContain("1 deletes");
    });
  });

  describe("flushPendingNow", () => {
    it("waits for vault event recording, then pushes queued mutations immediately", async () => {
      const order: string[] = [];
      vi.spyOn(SyncEngine.prototype, "isAutoSyncStarted").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "waitForLocalMutationWork").mockImplementation(async () => {
        order.push("wait");
      });
      vi.spyOn(SyncEngine.prototype, "countPendingMutations").mockImplementation(async () => {
        order.push("count");
        return 3;
      });
      const flushPendingPush = vi
        .spyOn(SyncEngine.prototype, "flushPendingPush")
        .mockImplementation(async () => {
          order.push("flush");
        });
      const controller = new SyncController(createDeps());

      await controller.flushPendingNow();

      expect(flushPendingPush).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["wait", "count", "flush"]);
      expect(controller.getActivityLog().some((entry) => entry.kind === "flush")).toBe(true);
    });

    it("does nothing when no mutations are queued", async () => {
      vi.spyOn(SyncEngine.prototype, "isAutoSyncStarted").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "countPendingMutations").mockResolvedValue(0);
      const flushPendingPush = vi
        .spyOn(SyncEngine.prototype, "flushPendingPush")
        .mockResolvedValue();
      const controller = new SyncController(createDeps());

      await controller.flushPendingNow();

      expect(flushPendingPush).not.toHaveBeenCalled();
      expect(controller.getActivityLog()).toEqual([]);
    });

    it("does nothing while paused or before the loop started", async () => {
      vi.spyOn(SyncEngine.prototype, "countPendingMutations").mockResolvedValue(2);
      vi.spyOn(SyncEngine.prototype, "pauseAutoSync").mockImplementation(() => {});
      const started = vi.spyOn(SyncEngine.prototype, "isAutoSyncStarted").mockReturnValue(false);
      const flushPendingPush = vi
        .spyOn(SyncEngine.prototype, "flushPendingPush")
        .mockResolvedValue();
      const controller = new SyncController(createDeps());

      await controller.flushPendingNow();
      started.mockReturnValue(true);
      controller.pauseAutoSync();
      await controller.flushPendingNow();

      expect(flushPendingPush).not.toHaveBeenCalled();
    });

    it("does not hang on a push that never finishes", async () => {
      vi.useFakeTimers();
      vi.spyOn(SyncEngine.prototype, "isAutoSyncStarted").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "countPendingMutations").mockResolvedValue(1);
      vi.spyOn(SyncEngine.prototype, "flushPendingPush").mockImplementation(
        () => new Promise<void>(() => {}),
      );
      const controller = new SyncController(createDeps());

      let done = false;
      const flushed = controller.flushPendingNow().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await flushed;
      expect(done).toBe(true);
      vi.useRealTimers();
    });

    it("persists the activity log so a kill after hide keeps it", async () => {
      vi.spyOn(SyncEngine.prototype, "isAutoSyncStarted").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "countPendingMutations").mockResolvedValue(1);
      vi.spyOn(SyncEngine.prototype, "flushPendingPush").mockResolvedValue();
      const save = vi.fn();
      const controller = new SyncController(
        createDeps({ activityLogStorage: { load: () => null, save } }),
      );

      await controller.flushPendingNow();

      expect(save).toHaveBeenCalled();
    });
  });

  describe("getPendingUploadCount", () => {
    it("returns the number of queued local mutations", async () => {
      vi.spyOn(SyncEngine.prototype, "countPendingMutations").mockResolvedValue(7);
      const controller = new SyncController(createDeps());

      expect(await controller.getPendingUploadCount()).toBe(7);
    });

    it("returns 0 instead of throwing when the store cannot be read", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(SyncEngine.prototype, "countPendingMutations").mockRejectedValue(
        new Error("db closed"),
      );
      const controller = new SyncController(createDeps());

      expect(await controller.getPendingUploadCount()).toBe(0);
    });
  });

  describe("device sync issues", () => {
    const issuesOf = (controller: SyncController) =>
      (controller as unknown as { deviceSyncIssues: DeviceSyncIssues }).deviceSyncIssues;

    it("exposes unwritable paths and portability warnings and notifies listeners", () => {
      const controller = new SyncController(createDeps({ platform: { isWin: true } }));
      const listener = vi.fn();
      const unsubscribe = controller.onDeviceSyncIssuesChange(listener);

      issuesOf(controller).applyPullEvent({
        kind: "skipped",
        entryId: "a",
        path: "x?.md",
        reason: "bad",
      });
      issuesOf(controller).noteLocalPaths(["y*.md"]);

      expect(controller.getUnwritablePaths()).toEqual([
        { path: "x?.md", reason: "bad", at: expect.any(Number) },
      ]);
      expect(controller.getPortabilityWarnings()).toEqual([
        { path: "y*.md", reason: 'contains "*"' },
      ]);
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
      issuesOf(controller).forgetLocalPath("y*.md");
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("persists unwritable paths through the storage port", () => {
      let saved: string | null = null;
      const unwritablePathsStorage = {
        load: () => saved,
        save: (json: string) => {
          saved = json;
        },
      };
      const first = new SyncController(createDeps({ unwritablePathsStorage }));
      issuesOf(first).applyPullEvent({ kind: "write_failed", entryId: "b", path: "b.md", reason: "x" });

      const second = new SyncController(createDeps({ unwritablePathsStorage }));
      expect(second.getUnwritablePaths().map((entry) => entry.path)).toEqual(["b.md"]);
    });

    it("counts unreadable entries, persists them, and reports changes to the same listeners", () => {
      let saved: string | null = null;
      const unreadableEntriesStorage = {
        load: () => saved,
        save: (json: string) => {
          saved = json;
        },
      };
      const controller = new SyncController(createDeps({ unreadableEntriesStorage }));
      const listener = vi.fn();
      controller.onDeviceSyncIssuesChange(listener);

      issuesOf(controller).noteUnreadableEntry("e1");

      expect(controller.getUnreadableEntryCount()).toBe(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(
        new SyncController(createDeps({ unreadableEntriesStorage })).getUnreadableEntryCount(),
      ).toBe(1);
    });

    it("retries failed writes, then runs a catch-up check", async () => {
      const retry = vi
        .spyOn(SyncEngine.prototype, "retryUnwritablePaths")
        .mockResolvedValue({ retried: 1, failed: 0 });
      const controller = new SyncController(createDeps());
      const checkNow = vi.spyOn(controller, "checkNow").mockResolvedValue();

      await controller.retryUnwritablePaths();

      expect(retry).toHaveBeenCalledTimes(1);
      expect(checkNow).toHaveBeenCalledTimes(1);
      expect(retry.mock.invocationCallOrder[0]).toBeLessThan(
        checkNow.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it("surfaces a retry failure instead of throwing", async () => {
      vi.spyOn(SyncEngine.prototype, "retryUnwritablePaths").mockRejectedValue(
        new Error("Local sync store is not initialized."),
      );
      const notifyError = vi.fn();
      const controller = new SyncController(createDeps({ notifyError }));

      await controller.retryUnwritablePaths();

      expect(notifyError).toHaveBeenCalledWith(expect.any(Error), "Retry failed");
    });
  });

  describe("checkNow", () => {
    function mockRunningLoop() {
      vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "isAutoSyncStarted").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(false);
      vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(false);
      vi.spyOn(SyncEngine.prototype, "notifyLocalChange").mockImplementation(() => {});
      const reconcileOnce = vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
        filesScanned: 0,
        filesQueuedForUpsert: 0,
        filesQueuedForDelete: 0,
      });
      const resumeAutoSyncConnection = vi
        .spyOn(SyncEngine.prototype, "resumeAutoSyncConnection")
        .mockResolvedValue();
      return { reconcileOnce, resumeAutoSyncConnection };
    }

    it("re-verifies the connection and catches up, bypassing the scan throttle", async () => {
      const { reconcileOnce, resumeAutoSyncConnection } = mockRunningLoop();
      const controller = new SyncController(createDeps());

      await controller.resumeAutoSync();
      expect(reconcileOnce).toHaveBeenCalledTimes(1);

      await controller.checkNow();
      expect(reconcileOnce).toHaveBeenCalledTimes(2);
      expect(resumeAutoSyncConnection).toHaveBeenCalledTimes(2);
      expect(controller.getActivityLog().some((entry) => entry.kind === "resume")).toBe(true);
    });

    it("runs the full startup path when the loop never started", async () => {
      vi.spyOn(SyncEngine.prototype, "hasStore").mockReturnValue(true);
      vi.spyOn(SyncEngine.prototype, "isAutoSyncStarted").mockReturnValue(false);
      const runInitialPull = vi
        .spyOn(SyncEngine.prototype, "runInitialPullIfRequired")
        .mockResolvedValue();
      vi.spyOn(SyncEngine.prototype, "reconcileOnce").mockResolvedValue({
        filesScanned: 0,
        filesQueuedForUpsert: 0,
        filesQueuedForDelete: 0,
      });
      vi.spyOn(SyncEngine.prototype, "hasPendingMutations").mockResolvedValue(false);
      const startAutoSync = vi.spyOn(SyncEngine.prototype, "startAutoSync").mockResolvedValue(true);
      const resumeAutoSyncConnection = vi
        .spyOn(SyncEngine.prototype, "resumeAutoSyncConnection")
        .mockResolvedValue();
      const controller = new SyncController(createDeps());

      await controller.checkNow();

      expect(runInitialPull).toHaveBeenCalledTimes(1);
      expect(startAutoSync).toHaveBeenCalledTimes(1);
      expect(resumeAutoSyncConnection).not.toHaveBeenCalled();
    });

    it("cancels a pending startup retry and resets its backoff", async () => {
      vi.useFakeTimers();
      const runInitialPull = vi
        .spyOn(SyncEngine.prototype, "runInitialPullIfRequired")
        .mockRejectedValue(new TypeError("Failed to fetch"));
      vi.spyOn(SyncEngine.prototype, "isAutoSyncStarted").mockReturnValue(false);
      const controller = new SyncController(createDeps());

      await controller.ensureAutoSyncState();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runInitialPull).toHaveBeenCalledTimes(3);

      await controller.checkNow();
      expect(runInitialPull).toHaveBeenCalledTimes(4);
      // Backoff restarted at the base delay rather than 20s.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runInitialPull).toHaveBeenCalledTimes(5);
      controller.stopAutoSyncAndMarkNotReady();
      vi.useRealTimers();
    });

    it("does nothing without an active remote session", async () => {
      const resumeAutoSyncConnection = vi
        .spyOn(SyncEngine.prototype, "resumeAutoSyncConnection")
        .mockResolvedValue();
      const controller = new SyncController(
        createDeps({ hasActiveRemoteVaultSession: () => false }),
      );

      await expect(controller.checkNow()).resolves.toBeUndefined();
      expect(resumeAutoSyncConnection).not.toHaveBeenCalled();
    });

    it("re-fetches quarantined entries, and a failure there does not fail the check", async () => {
      const { resumeAutoSyncConnection } = mockRunningLoop();
      const recover = vi
        .spyOn(SyncEngine.prototype, "recoverUnreadableEntries")
        .mockRejectedValue(new Error("offline"));
      const controller = new SyncController(createDeps());

      await controller.checkNow();

      expect(recover).toHaveBeenCalledWith({ force: true });
      expect(resumeAutoSyncConnection).toHaveBeenCalledTimes(1);
      expect(controller.getSyncState()).not.toBe("attention_needed");
      expect(
        controller
          .getActivityLog()
          .some((entry) => entry.message.includes("Re-fetching unreadable entries failed")),
      ).toBe(true);
    });

    it("resolves and surfaces the failure instead of throwing", async () => {
      const { resumeAutoSyncConnection } = mockRunningLoop();
      resumeAutoSyncConnection.mockRejectedValue(new Error("boom"));
      const controller = new SyncController(createDeps());

      await expect(controller.checkNow()).resolves.toBeUndefined();

      expect(controller.getSyncState()).toBe("attention_needed");
      expect(controller.getActivityLog().some((entry) => entry.kind === "error")).toBe(true);
    });
  });

  it("exposes when the server cursor was last verified", () => {
    vi.spyOn(SyncEngine.prototype, "getLastVerifiedAt").mockReturnValue(1_234);
    const controller = new SyncController(createDeps());

    expect(controller.getLastVerifiedAt()).toBe(1_234);
  });
});

function createDeps(
  overrides: Partial<ConstructorParameters<typeof SyncController>[0]> = {},
): ConstructorParameters<typeof SyncController>[0] {
  return {
    plugin: createTestPlugin(),
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    invalidateSyncToken: vi.fn(),
    crypto: new VaultKeyCryptoService(() => new Uint8Array(32)),
    getSyncFileRules: () => ({
      includeGlobs: [],
      excludeGlobs: [],
      maxFileBytes: 10_000_000,
    }),
    hasActiveRemoteVaultSession: () => true,
    hasAuthenticatedSession: () => true,
    notifyError: vi.fn(),
    ...overrides,
  };
}

function createToken(): SyncTokenResponse {
  return {
    token: "sync-token",
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
  };
}
