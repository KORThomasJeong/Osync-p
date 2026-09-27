import { describe, expect, it, vi } from "vitest";

import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import type {
  SyncRealtimeCallbacks,
  SyncRealtimeSession,
} from "../../../remote/realtime-client";
import { SyncAutoLoop, type SyncAutoLoopDeps } from "../../auto-sync";
import {
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";

async function createLoop(
  overrides: Partial<SyncAutoLoopDeps> = {},
  serverCursor = 0,
) {
  const store = await createInitializedTestSyncStore(createTestPlugin());
  const callbacks: SyncRealtimeCallbacks[] = [];
  const sessions: SyncRealtimeSession[] = [];
  const pullOnce = vi.fn(async () => {});
  const pushPendingMutations = vi.fn(async () => createPushResult());
  const loop = new SyncAutoLoop({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    pushPendingMutations,
    pullOnce,
    realtimeClient: createRealtimeClient(
      (nextCallbacks) => {
        callbacks.push(nextCallbacks);
      },
      (session) => {
        sessions.push(session);
      },
      serverCursor,
    ),
    ...overrides,
  });
  return { store, loop, callbacks, sessions, pullOnce, pushPendingMutations };
}

describe("SyncAutoLoop resume catch-up", () => {
  it("pulls to catch up after resuming with a live socket", async () => {
    const { store, loop, pullOnce } = await createLoop();

    await loop.start();
    expect(pullOnce).toHaveBeenCalledTimes(0);

    await loop.resumeConnection();

    expect(pullOnce).toHaveBeenCalledTimes(1);
    loop.stop();
    await store.close();
  });

  it("reports the verification start before the catch-up pull and idles only after it", async () => {
    const order: string[] = [];
    let finishPull: () => void = () => {};
    const pullOnce = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push("pull:start");
          finishPull = () => {
            order.push("pull:end");
            resolve();
          };
        }),
    );
    const { store, loop } = await createLoop({
      pullOnce,
      onVerificationStarted: () => order.push("verify"),
      onIdle: () => order.push("idle"),
    });

    await loop.start();
    order.length = 0;

    const resumed = loop.resumeConnection();
    await vi.waitFor(() => expect(pullOnce).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["verify", "pull:start"]);

    finishPull();
    await resumed;

    expect(order).toEqual(["verify", "pull:start", "pull:end", "idle"]);
    loop.stop();
    await store.close();
  });

  it("resets the sync retry backoff on resume", async () => {
    vi.useFakeTimers();
    const pullOnce = vi.fn(async () => {
      throw new Error("offline");
    });
    const { store, loop } = await createLoop(
      {
        pullOnce,
        syncRetryBaseDelayMs: 1_000,
        syncRetryMaxDelayMs: 60_000,
      },
      5,
    );

    await loop.start();
    await vi.advanceTimersByTimeAsync(0);
    // Initial pull fails, then retries at 1s and 2s; the next retry waits 4s.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pullOnce).toHaveBeenCalledTimes(3);

    await loop.resumeConnection();
    expect(pullOnce).toHaveBeenCalledTimes(4);

    // Fresh start: the next retry is back at the base delay, not 8s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pullOnce).toHaveBeenCalledTimes(5);
    loop.stop();
    await store.close();
  });

  it("records cursor_advanced while paused and pulls on resume", async () => {
    const { store, loop, callbacks, pullOnce } = await createLoop();

    await loop.start();
    loop.pause();
    callbacks[0]?.onCursorAdvanced(7);
    await Promise.resolve();
    expect(pullOnce).toHaveBeenCalledTimes(0);
    const pendingWork = (
      loop as unknown as {
        pendingWork: { pullTargetCursor: number | null };
      }
    ).pendingWork;
    expect(pendingWork.pullTargetCursor).toBe(7);

    loop.resume();
    await vi.waitFor(() => expect(pullOnce).toHaveBeenCalledTimes(1));
    loop.stop();
    await store.close();
  });

  it("always catches up on resume from pause instead of idling straight away", async () => {
    const order: string[] = [];
    const pullOnce = vi.fn(async () => {
      order.push("pull");
    });
    const { store, loop } = await createLoop({
      pullOnce,
      onIdle: () => order.push("idle"),
    });

    await loop.start();
    loop.pause();
    order.length = 0;

    loop.resume();
    await vi.waitFor(() => expect(order).toContain("idle"));

    expect(order).toEqual(["pull", "idle"]);
    loop.stop();
    await store.close();
  });

  it("reconnects on resume from pause when the socket died while paused", async () => {
    const { store, loop, callbacks, sessions, pullOnce } = await createLoop();

    await loop.start();
    loop.pause();
    // The socket closes while paused: the close is ignored, so the loop still holds it.
    sessions[0]!.ping = async () => {
      throw new Error("sync websocket is closed");
    };
    callbacks[0]?.onClose();

    loop.resume();
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    // The new session verifies via its hello cursor (server 0 == local 0): no pull needed.
    expect(pullOnce).toHaveBeenCalledTimes(0);
    loop.stop();
    await store.close();
  });

  it("does not implicitly unpause when start() is called while paused", async () => {
    const { store, loop, callbacks } = await createLoop();

    await loop.start();
    loop.pause();

    expect(await loop.start()).toBe(false);
    await loop.resumeConnection();

    const state = (loop as unknown as { state: { current: string } }).state;
    expect(state.current).toBe("paused");
    expect(callbacks).toHaveLength(1);
    loop.stop();
    await store.close();
  });

  it("does not hit an invalid state transition when resuming during reconnect backoff", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { store, loop, callbacks } = await createLoop({
      onError,
      reconnectDelayMs: 1_000,
    });

    await loop.start();
    loop.pause();
    loop.resume();
    await vi.advanceTimersByTimeAsync(0);
    callbacks.at(-1)?.onClose();
    await loop.resumeConnection();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onError).not.toHaveBeenCalled();
    loop.stop();
    await store.close();
  });
});

describe("SyncAutoLoop lastVerifiedAt", () => {
  it("is set by a hello whose server cursor is not ahead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { store, loop } = await createLoop();

    expect(loop.getLastVerifiedAt()).toBeNull();
    await loop.start();

    expect(loop.getLastVerifiedAt()).toBe(1_000_000);
    loop.stop();
    await store.close();
  });

  it("waits for the pull when the hello cursor is ahead, and ignores failed pulls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const pullOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({});
    const { store, loop } = await createLoop(
      { pullOnce, syncRetryBaseDelayMs: 1_000 },
      3,
    );

    await loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(loop.getLastVerifiedAt()).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pullOnce).toHaveBeenCalledTimes(2);
    expect(loop.getLastVerifiedAt()).toBe(1_001_000);
    loop.stop();
    await store.close();
  });

  it("can be marked verified externally and is cleared on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const { store, loop } = await createLoop();

    await loop.start();
    vi.setSystemTime(9_000);
    loop.markVerified();
    expect(loop.getLastVerifiedAt()).toBe(9_000);

    loop.stop();
    expect(loop.getLastVerifiedAt()).toBeNull();
    await store.close();
  });
});
