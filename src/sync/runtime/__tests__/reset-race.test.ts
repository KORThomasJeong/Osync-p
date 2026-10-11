import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultKeyCryptoService } from "../../core/crypto-service";
import type { SyncTokenResponse } from "../../remote/client";
import { SyncPullService } from "../../engine/pull-service";
import { SyncPushService } from "../../engine/push-service";
import { createRealtimeClient } from "../../engine/__tests__/auto-sync/helpers";
import { SyncStoreDetachedError } from "../../store/detachable-store";
import type { SyncStore } from "../../store/store";
import { createTestPlugin } from "../../../test-support/test-plugin";
import { SyncController } from "../controller";
import type { SyncEngine } from "../engine";

function createToken(): SyncTokenResponse {
  return { token: "sync-token", expiresAt: 1_000, vaultId: "vault-1", localVaultId: "local-1" };
}

function createDeferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createController() {
  const notifyError = vi.fn();
  const controller = new SyncController({
    plugin: createTestPlugin(),
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    invalidateSyncToken: vi.fn(),
    crypto: new VaultKeyCryptoService(() => new Uint8Array(32)),
    getSyncFileRules: () => ({ includeGlobs: [], excludeGlobs: [], maxFileBytes: 10_000_000 }),
    hasActiveRemoteVaultSession: () => true,
    hasAuthenticatedSession: () => true,
    notifyError,
  });
  const engine = (controller as unknown as { syncEngine: SyncEngine }).syncEngine;
  (engine as unknown as { syncAutoLoop: { realtimeClient: unknown } }).syncAutoLoop.realtimeClient =
    createRealtimeClient();
  return { controller, engine, notifyError };
}

async function arrangeStuckDeviceState(store: SyncStore): Promise<void> {
  await store.setCursor(8968);
  await store.markEntryDirty({
    mutationId: "mutation-old",
    entryId: "entry-old",
    op: "delete",
    baseRevision: 3,
    blobId: null,
    hash: null,
    encryptedMetadata: "old-key-ciphertext",
    createdAt: 1,
  });
}

describe("Reset local sync state while sync is running", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for the in-flight drain, starts no further step, and leaves a fresh store", async () => {
    const { controller, engine } = createController();
    await controller.initializeStore("vault-1");
    const store = engine.getStoreOrNull()!;
    await arrangeStuckDeviceState(store);

    const pushGate = createDeferred();
    let pushStarted = false;
    vi.spyOn(SyncPushService.prototype, "pushPendingMutations").mockImplementation(async () => {
      pushStarted = true;
      await pushGate.promise;
      // Still running against the old store when the reset began.
      await store.setCursor(9000);
      return {
        cursor: 9000,
        mutationsPushed: 0,
        mutationsRequeued: 1,
        mutationsDropped: 0,
        filesCreatedOrUpdated: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        shouldPullAfterPush: true,
        hasMore: true,
      };
    });
    const pullOnce = vi.spyOn(SyncPullService.prototype, "pullOnce");
    vi.spyOn(engine, "runInitialPullIfRequired").mockResolvedValue();
    vi.spyOn(engine, "reconcileOnce").mockResolvedValue({
      filesScanned: 0,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });

    await engine.startAutoSync();
    const flush = engine.flushPendingPush();
    await vi.waitFor(() => expect(pushStarted).toBe(true));

    let resetDone = false;
    const reset = controller.resetLocalSyncState({ preserveLocalVaultId: true }).then(() => {
      resetDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resetDone).toBe(false);

    pushGate.resolve();
    await Promise.all([reset, flush]);

    // The push's follow-up pull never ran against the torn-down store.
    expect(pullOnce).not.toHaveBeenCalled();
    // Stray work holding the old store hits the detach guard, not a deleted DB.
    await expect(store.setCursor(1)).rejects.toBeInstanceOf(SyncStoreDetachedError);
    await expect(store.listDirtyEntries()).rejects.toBeInstanceOf(SyncStoreDetachedError);

    await controller.initializeStore("vault-1");
    const fresh = engine.getStoreOrNull()!;
    expect(await fresh.getCursor()).toBe(0);
    expect(await fresh.listDirtyEntries()).toEqual([]);
    await controller.stop();
  });

  it("ignores flush, check and resume requests that arrive while the reset runs", async () => {
    const { controller, engine, notifyError } = createController();
    await controller.initializeStore("vault-1");
    await arrangeStuckDeviceState(engine.getStoreOrNull()!);
    const localGate = createDeferred();
    // Local work in flight (e.g. a vault event being recorded) holds the reset.
    void (engine as unknown as {
      runLocalMutationWork(work: () => Promise<void>): Promise<void>;
    }).runLocalMutationWork(async () => {
      await localGate.promise;
    });
    const startAutoSync = vi.spyOn(engine, "startAutoSync");

    const reset = controller.resetLocalSyncState({ preserveLocalVaultId: true });
    await controller.flushPendingNow();
    await controller.checkNow();
    await controller.resumeAutoSync();
    localGate.resolve();
    await reset;

    expect(startAutoSync).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
    expect(controller.getSyncState()).toBe("not_ready");
    await controller.stop();
  });
});
