import { describe, expect, it, vi } from "vitest";

import {
  createMutation,
  openRealtimeSession,
  waitForSentMessage,
} from "./helpers";

describe("SyncRealtimeClient connection health", () => {
  it("exposes the server storage and file size policy from hello acknowledgement", async () => {
    const { session } = await openRealtimeSession();

    expect(session.maxFileSizeBytes).toBe(3_000_000);
    expect(session.storageUsedBytes).toBe(24_300_000);
    expect(session.storageLimitBytes).toBe(100_000_000);
    session.close();
  });

  it("uses the fresh policy storage limit when the stored status is stale", async () => {
    const { session } = await openRealtimeSession({
      helloPolicy: {
        storageLimitBytes: 1_000_000_000,
        maxFileSizeBytes: 3_000_000,
      },
      helloStorageStatus: {
        storageUsedBytes: 24_300_000,
        storageLimitBytes: 50_000_000,
      },
    });

    expect(session.storageUsedBytes).toBe(24_300_000);
    expect(session.storageLimitBytes).toBe(1_000_000_000);
    session.close();
  });

  it("rejects pending requests and closes the session when a request times out", async () => {
    vi.useFakeTimers();

    const errors: Error[] = [];
    const onClose = vi.fn();
    const { session } = await openRealtimeSession({
      clientOptions: {
        requestTimeoutMs: 100,
      },
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    const commitPromise = session.commitMutation(createMutation());
    const commitExpectation = expect(commitPromise).rejects.toThrow(
      "sync websocket request timed out",
    );
    await vi.advanceTimersByTimeAsync(100);

    await commitExpectation;
    expect(errors).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the session when a websocket send fails", async () => {
    const errors: Error[] = [];
    const onClose = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    socket.failNextSend = true;
    const commitPromise = session.commitMutation(createMutation());

    await expect(commitPromise).rejects.toThrow("send failed");
    expect(errors).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses heartbeat messages to detect a stale websocket", async () => {
    vi.useFakeTimers();

    const errors: Error[] = [];
    const onClose = vi.fn();
    const { socket } = await openRealtimeSession({
      clientOptions: {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 250,
      },
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSentMessage(socket, 1);
    expect(socket.sentMessageAt(1)).toMatchObject({
      type: "heartbeat",
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(errors.map((error) => error.message)).toEqual([
      "sync websocket request timed out",
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the session open when heartbeat acknowledgements arrive", async () => {
    vi.useFakeTimers();

    const onClose = vi.fn();
    const errors: Error[] = [];
    const { socket, session } = await openRealtimeSession({
      clientOptions: {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 250,
      },
      callbacks: {
        onClose,
        onError(error) {
          errors.push(error);
        },
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForSentMessage(socket, 1);
    const heartbeat = socket.sentMessageAt(1);
    socket.emitMessage({
      type: "heartbeat_ack",
      requestId: heartbeat.requestId,
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(errors).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    session.close();
  });
});
