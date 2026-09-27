import { describe, expect, it, vi } from "vitest";

import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import type {
  SyncRealtimeCallbacks,
  SyncRealtimeSession,
} from "../../../remote/realtime-client";
import { SyncAutoLoop, type SyncAutoLoopDeps } from "../../auto-sync";
import { createPushResult, createRealtimeClient, createToken } from "./helpers";

async function createLoop(
  overrides: Partial<SyncAutoLoopDeps> = {},
  options: { serverCursor?: number; localCursor?: number } = {},
) {
  const store = await createInitializedTestSyncStore(createTestPlugin());
  await store.setCursor(options.localCursor ?? 0);
  const callbacks: SyncRealtimeCallbacks[] = [];
  const sessions: SyncRealtimeSession[] = [];
  const activity: Array<{ kind: string; message: string }> = [];
  const pullOnce = vi.fn(async () => {});
  const pushPendingMutations = vi.fn(async () => createPushResult());
  const loop = new SyncAutoLoop({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    pushPendingMutations,
    pullOnce,
    onActivity: (kind, message) => activity.push({ kind, message }),
    realtimeClient: createRealtimeClient(
      (nextCallbacks) => {
        callbacks.push(nextCallbacks);
      },
      (session) => {
        sessions.push(session);
      },
      options.serverCursor ?? 0,
    ),
    ...overrides,
  });
  return { store, loop, callbacks, sessions, activity, pullOnce, pushPendingMutations };
}

const kinds = (activity: Array<{ kind: string }>) => activity.map((entry) => entry.kind);

describe("SyncAutoLoop activity reporting", () => {
  it("reports the connection with the local and server cursors", async () => {
    const { store, loop, activity } = await createLoop({}, { localCursor: 2, serverCursor: 5 });

    await loop.start();

    const connect = activity.find((entry) => entry.kind === "connect");
    expect(connect?.message).toContain("2");
    expect(connect?.message).toContain("5");
    loop.stop();
    await store.close();
  });

  it("reports a socket close as a disconnect", async () => {
    const { store, loop, callbacks, activity } = await createLoop({ reconnectDelayMs: 60_000 });

    await loop.start();
    callbacks[0]?.onClose();

    expect(kinds(activity)).toContain("disconnect");
    loop.stop();
    await store.close();
  });

  it("reports a resume and a failed liveness ping", async () => {
    const { store, loop, sessions, activity } = await createLoop();

    await loop.start();
    sessions[0]!.ping = async () => {
      throw new Error("dead");
    };
    await loop.resumeConnection();

    expect(kinds(activity)).toContain("resume");
    expect(
      activity.some(
        (entry) => entry.kind === "disconnect" && /ping/i.test(entry.message),
      ),
    ).toBe(true);
    loop.stop();
    await store.close();
  });
});

describe("SyncAutoLoop heartbeat verification", () => {
  it("refreshes the verification time when a heartbeat confirms our cursor", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { store, loop, callbacks } = await createLoop({}, { localCursor: 4, serverCursor: 4 });

    await loop.start();
    expect(loop.getLastVerifiedAt()).toBe(1_000);

    now.mockReturnValue(31_000);
    callbacks[0]?.onServerCursorConfirmed?.(4);

    await vi.waitFor(() => expect(loop.getLastVerifiedAt()).toBe(31_000));
    loop.stop();
    await store.close();
  });

  it("does not verify when the local cursor is behind the confirmed cursor", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { store, loop, callbacks } = await createLoop({}, { localCursor: 4, serverCursor: 4 });

    await loop.start();
    await store.setCursor(2);
    now.mockReturnValue(31_000);
    callbacks[0]?.onServerCursorConfirmed?.(4);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(loop.getLastVerifiedAt()).toBe(1_000);
    loop.stop();
    await store.close();
  });

  it("does not verify while pull work is pending", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let finishPull: () => void = () => {};
    const pullOnce = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPull = resolve;
        }),
    );
    const { store, loop, callbacks } = await createLoop(
      { pullOnce },
      { localCursor: 4, serverCursor: 4 },
    );

    await loop.start();
    loop.requestPull(6);
    await vi.waitFor(() => expect(pullOnce).toHaveBeenCalledTimes(1));

    now.mockReturnValue(31_000);
    callbacks[0]?.onServerCursorConfirmed?.(4);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loop.getLastVerifiedAt()).toBe(1_000);

    finishPull();
    loop.stop();
    await store.close();
  });

  it("ignores confirmations while paused", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { store, loop, callbacks } = await createLoop({}, { localCursor: 4, serverCursor: 4 });

    await loop.start();
    loop.pause();
    now.mockReturnValue(31_000);
    callbacks[0]?.onServerCursorConfirmed?.(4);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(loop.getLastVerifiedAt()).toBe(1_000);
    loop.stop();
    await store.close();
  });

  it("coalesces heartbeat verification entries", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { store, loop, callbacks, activity } = await createLoop(
      {},
      { localCursor: 4, serverCursor: 4 },
    );
    await loop.start();
    const verifyCount = () => activity.filter((entry) => entry.kind === "verify").length;
    const confirm = async (at: number, cursor: number) => {
      now.mockReturnValue(at);
      callbacks[0]?.onServerCursorConfirmed?.(cursor);
      await vi.waitFor(() => expect(loop.getLastVerifiedAt()).toBe(at));
    };

    // The hello already confirmed cursor 4: a heartbeat 30s later adds nothing.
    await confirm(31_000, 4);
    expect(verifyCount()).toBe(0);

    // Five minutes after the last logged check, log again.
    await confirm(1_000 + 5 * 60_000, 4);
    expect(verifyCount()).toBe(1);
    await confirm(1_000 + 5 * 60_000 + 30_000, 4);
    expect(verifyCount()).toBe(1);

    // A different cursor is always worth a line.
    await store.setCursor(5);
    await confirm(1_000 + 5 * 60_000 + 60_000, 5);
    expect(verifyCount()).toBe(2);
    expect(activity.at(-1)?.message).toContain("5");
    loop.stop();
    await store.close();
  });
});

describe("SyncAutoLoop flushPendingPush", () => {
  it("pushes immediately instead of waiting for the debounce", async () => {
    vi.useFakeTimers();
    const { store, loop, pushPendingMutations } = await createLoop({ pushDebounceMs: 5_000 });
    await loop.start();

    loop.notifyLocalChange();
    await loop.flushPendingPush();
    expect(pushPendingMutations).toHaveBeenCalledTimes(1);

    // The debounce timer was cancelled: no second push when it would have fired.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    loop.stop();
    await store.close();
  });

  it("does nothing when the loop is not active", async () => {
    const { store, loop, pushPendingMutations } = await createLoop();

    await loop.flushPendingPush();
    expect(pushPendingMutations).not.toHaveBeenCalled();

    await loop.start();
    loop.pause();
    await loop.flushPendingPush();
    expect(pushPendingMutations).not.toHaveBeenCalled();
    loop.stop();
    await store.close();
  });

  it("reports whether the loop has been started", async () => {
    const { store, loop } = await createLoop();

    expect(loop.isStarted()).toBe(false);
    await loop.start();
    expect(loop.isStarted()).toBe(true);
    loop.pause();
    expect(loop.isStarted()).toBe(true);
    loop.stop();
    expect(loop.isStarted()).toBe(false);
    await store.close();
  });
});
