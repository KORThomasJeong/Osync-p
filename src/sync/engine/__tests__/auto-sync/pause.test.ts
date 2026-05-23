import { describe, expect, it, vi } from "vitest";

import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncAutoLoop } from "../../auto-sync";
import {
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";

describe("SyncAutoLoop pause/resume", () => {
  it("does not push when paused", async () => {
    vi.useFakeTimers();
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});

    const loop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 100,
    });

    await loop.start();
    loop.pause();
    loop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(300);

    expect(pushPendingMutations).toHaveBeenCalledTimes(0);
    loop.stop();
    await store.close();
  });

  it("resumes pushing after resume()", async () => {
    vi.useFakeTimers();
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});

    const loop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 100,
    });

    await loop.start();
    loop.pause();
    loop.resume();
    loop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(300);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    loop.stop();
    await store.close();
  });

  it("stop() after pause() cleans up without error", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const loop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient(),
    });

    await loop.start();
    loop.pause();
    expect(() => loop.stop()).not.toThrow();
    await store.close();
  });
});
