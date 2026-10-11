import { describe, expect, it, vi } from "vitest";

import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import type {
  SyncRealtimeCallbacks,
  SyncRealtimeSession,
} from "../../../remote/realtime-client";
import { SyncAutoLoop, type SyncAutoLoopDeps } from "../../auto-sync";
import { createPushResult, createRealtimeClient, createToken } from "./helpers";

function createDeferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met in time");
}

const invalidTransitions = (errors: unknown[]) =>
  errors.filter((error) => String(error).includes("Invalid transition"));

async function createLoop(overrides: Partial<SyncAutoLoopDeps> = {}) {
  const store = await createInitializedTestSyncStore(createTestPlugin());
  const callbacks: SyncRealtimeCallbacks[] = [];
  const sessions: SyncRealtimeSession[] = [];
  const errors: unknown[] = [];
  const base = createRealtimeClient(
    (next) => callbacks.push(next),
    (session) => sessions.push(session),
  );
  // Sessions after the first can be held open to stage a race with the connect.
  let gate: Promise<void> | null = null;
  const realtimeClient: SyncAutoLoopDeps["realtimeClient"] = {
    async openSession(...args) {
      if (gate) {
        await gate;
      }
      return await base.openSession(...args);
    },
  };
  const pushPendingMutations = vi.fn(async () => createPushResult());
  const loop = new SyncAutoLoop({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    pushPendingMutations,
    pullOnce: vi.fn(async () => {}),
    realtimeClient,
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return {
    store,
    loop,
    callbacks,
    sessions,
    errors,
    pushPendingMutations,
    holdNextConnect(): () => void {
      const deferred = createDeferred();
      gate = deferred.promise;
      return () => {
        gate = null;
        deferred.resolve();
      };
    },
  };
}

describe("SyncAutoLoop state races", () => {
  it("lets a drain that started during a reconnect finish once the socket is live (no draining → live error)", async () => {
    const env = await createLoop();
    await env.loop.start();

    // Resume finds the socket dead and reconnects; the new connect is slow.
    env.sessions[0]!.ping = async () => {
      throw new Error("dead socket");
    };
    const release = env.holdNextConnect();
    const resume = env.loop.resumeConnection();
    await waitUntil(() => env.callbacks.length === 1 && env.loop.isStarted());
    // The app is hidden meanwhile: flush starts a drain while still connecting.
    const flush = env.loop.flushPendingPush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await Promise.all([resume, flush]);

    expect(invalidTransitions(env.errors)).toEqual([]);
    expect(env.pushPendingMutations).toHaveBeenCalled();
    env.loop.stop();
    await env.store.close();
  });

  it("does not throw reconnect_wait → retry_wait when a push fails because the socket closed", async () => {
    const env = await createLoop({ reconnectDelayMs: 5, syncRetryBaseDelayMs: 5 });
    await env.loop.start();
    let calls = 0;
    env.pushPendingMutations.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // The socket drops mid-push: the loop schedules a reconnect, then the
        // in-flight push rejects.
        env.callbacks[0]!.onClose();
        throw new Error("sync websocket closed before the request completed");
      }
      return createPushResult();
    });

    await expect(env.loop.flushPendingPush()).resolves.toBeUndefined();
    await waitUntil(() => calls >= 2);

    expect(invalidTransitions(env.errors)).toEqual([]);
    expect(calls).toBe(2);
    env.loop.stop();
    await env.store.close();
  });

  it("keeps the pending push when a sync retry is requested while a reconnect is scheduled", async () => {
    const env = await createLoop({ reconnectDelayMs: 5, syncRetryBaseDelayMs: 60_000 });
    await env.loop.start();
    let calls = 0;
    env.pushPendingMutations.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        env.callbacks[0]!.onClose();
        throw new Error("socket closed");
      }
      return createPushResult();
    });

    await env.loop.flushPendingPush();
    // The reconnect (5ms), not the 60s sync retry, must carry the push.
    await waitUntil(() => calls >= 2);

    expect(invalidTransitions(env.errors)).toEqual([]);
    env.loop.stop();
    await env.store.close();
  });

  it("waits for an in-flight drain on stopAndWait and runs no further step after stop", async () => {
    const env = await createLoop();
    await env.loop.start();
    const pushGate = createDeferred();
    const pullOnce = vi.fn(async () => {});
    (env.loop as unknown as { deps: SyncAutoLoopDeps }).deps.pullOnce = pullOnce;
    env.pushPendingMutations.mockImplementation(async () => {
      await pushGate.promise;
      return createPushResult({ shouldPullAfterPush: true });
    });

    const flush = env.loop.flushPendingPush();
    await waitUntil(() => env.pushPendingMutations.mock.calls.length === 1);
    let stopped = false;
    const stop = env.loop.stopAndWait().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);

    pushGate.resolve();
    await Promise.all([flush, stop]);

    expect(stopped).toBe(true);
    // The post-push pull must not start once the loop was stopped.
    expect(pullOnce).not.toHaveBeenCalled();
    await env.store.close();
  });
});
