import { describe, expect, it, vi } from "vitest";

import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncRealtimeClient } from "../../../remote/realtime-client";
import { MockWebSocket } from "../../../remote/__tests__/realtime-client/helpers";
import { SyncAutoLoop } from "../../auto-sync";
import { createPushResult, createToken } from "./helpers";

async function waitForSent(socket: MockWebSocket, index: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (socket.sent.length > index) {
      return socket.sentMessageAt(index);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`expected sent websocket message at index ${index}`);
}

describe("SyncAutoLoop resume heartbeat cursor", () => {
  it("pulls on resume when the liveness ping reveals a cursor advance missed while suspended", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.setCursor(5);
    const socket = new MockWebSocket();
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult({ mutationsPushed: 0 })),
      pullOnce,
      realtimeClient: new SyncRealtimeClient(
        {
          create: () => {
            setTimeout(() => socket.emit("open"), 0);
            return socket.asWebSocket();
          },
        },
        { heartbeatIntervalMs: 0 },
      ),
    });

    const started = autoLoop.start();
    const hello = await waitForSent(socket, 0);
    socket.emitMessage({
      type: "hello_ack",
      requestId: hello.requestId,
      cursor: 5,
      policy: { storageLimitBytes: 100_000_000, maxFileSizeBytes: 3_000_000 },
      storageStatus: { storageUsedBytes: 0, storageLimitBytes: 100_000_000 },
    });
    await started;
    expect(pullOnce).not.toHaveBeenCalled();

    // App suspended; another device committed cursor 6 and the broadcast was lost.
    const resumed = autoLoop.resumeConnection();
    const ping = await waitForSent(socket, 1);
    expect(ping.type).toBe("heartbeat");
    socket.emitMessage({ type: "heartbeat_ack", requestId: ping.requestId, cursor: 6 });
    await resumed;

    await vi.waitFor(() => {
      expect(pullOnce).toHaveBeenCalledTimes(1);
    });

    autoLoop.stop();
    await store.close();
  });
});
