import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncTokenResponse } from "../remote/client";
import { createTestPlugin } from "../../test-support/test-plugin";
import { SyncHttpError } from "../../http/request";
import { MassDeleteGuardError } from "../engine/mass-delete-guard";
import { SyncController } from "./controller";
import { VaultKeyCryptoService } from "../core/crypto-service";
import { SyncEngine } from "./engine";

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
