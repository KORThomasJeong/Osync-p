import { describe, expect, it, vi } from "vitest";

import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import type { SyncRealtimeCallbacks } from "../../../remote/realtime-client";
import { SyncAutoLoop } from "../../auto-sync";
import {
  createRealtimeClient,
  createToken,
} from "./helpers";

describe("SyncAutoLoop remote cursors", () => {
  it("pulls after reconnecting when the server cursor is ahead of the local cursor", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.setCursor(10);
    const pushPendingMutations = vi.fn(async () => {});
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, undefined, 11),
    });

    await autoLoop.start();
    await Promise.resolve();

    expect(pushPendingMutations).toHaveBeenCalledTimes(0);
    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenCalledWith(expect.objectContaining({ serverCursor: 11 }));
    autoLoop.stop();
    await store.close();
  });

  it("does not pull after reconnecting when the server cursor matches the local cursor", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.setCursor(10);
    const pushPendingMutations = vi.fn(async () => {});
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, undefined, 10),
    });

    await autoLoop.start();
    await Promise.resolve();

    expect(pushPendingMutations).toHaveBeenCalledTimes(0);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    autoLoop.stop();
    await store.close();
  });

  it("pulls when the realtime socket reports cursor advancement", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const pushPendingMutations = vi.fn(async () => {});
    const pullOnce = vi.fn(async () => {});
    let callbacks: SyncRealtimeCallbacks | null = null;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient((nextCallbacks) => {
        callbacks = nextCallbacks;
      }),
    });

    await autoLoop.start();
    callbacks?.onCursorAdvanced(12);
    await Promise.resolve();
    await Promise.resolve();

    expect(pushPendingMutations).toHaveBeenCalledTimes(0);
    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenCalledWith(expect.objectContaining({ serverCursor: 0 }));
    autoLoop.stop();
    await store.close();
  });
});
