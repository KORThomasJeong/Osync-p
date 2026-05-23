import { describe, expect, it, vi } from "vitest";

import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncAutoLoop } from "../../auto-sync";
import {
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";
import type { SyncRealtimeSession } from "../../../remote/realtime-client";

describe("SyncAutoLoop local changes", () => {
  it("runs ad-hoc realtime work on the active session", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const pushPendingMutations = vi.fn(async () => {});
    const pullOnce = vi.fn(async () => {});
    let openCount = 0;
    let session: SyncRealtimeSession | null = null;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(
        () => {
          openCount += 1;
        },
        (nextSession) => {
          session = nextSession;
        },
      ),
    });

    await autoLoop.start();
    const result = await autoLoop.withRealtimeSession(async (activeSession) => {
      expect(activeSession).toBe(session);
      return "done";
    });

    expect(result).toBe("done");
    expect(openCount).toBe(1);
    autoLoop.stop();
    await store.close();
  });

  it("debounces local changes into a single push", async () => {
    vi.useFakeTimers();

    const store = await createInitializedTestSyncStore(createTestPlugin());
    const pushPendingMutations = vi.fn(async () => {});
    const pullOnce = vi.fn(async () => {});
    let session: SyncRealtimeSession | null = null;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, (nextSession) => {
        session = nextSession;
      }),
      pushDebounceMs: 100,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();
    autoLoop.notifyLocalChange();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(pushPendingMutations).toHaveBeenCalledWith(session);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    autoLoop.stop();
    await store.close();
  });

  it("keeps pushing when the push service reports more pending work", async () => {
    vi.useFakeTimers();

    const store = await createInitializedTestSyncStore(createTestPlugin());
    const pushPendingMutations = vi
      .fn()
      .mockResolvedValueOnce(createPushResult({ hasMore: true }))
      .mockResolvedValueOnce(createPushResult({ hasMore: false }));
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 100,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(pushPendingMutations).toHaveBeenCalledTimes(2);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    autoLoop.stop();
    await store.close();
  });
});
