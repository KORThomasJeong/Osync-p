import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMutation,
  openRealtimeSession,
  type MockWebSocket,
  waitForSentMessage,
} from "./helpers";

// hello_ack in openRealtimeSession reports cursor 0, so the session starts
// knowing server cursor 0.

async function answerNextHeartbeat(
  socket: MockWebSocket,
  index: number,
  cursor: number | undefined,
): Promise<void> {
  await waitForSentMessage(socket, index);
  const heartbeat = socket.sentMessageAt(index);
  expect(heartbeat.type).toBe("heartbeat");
  socket.emitMessage({
    type: "heartbeat_ack",
    requestId: heartbeat.requestId,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

describe("SyncRealtimeClient heartbeat cursor verification", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays a missed cursor advance when a ping ack reports a higher cursor", async () => {
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
    });

    const ping = session.ping();
    await answerNextHeartbeat(socket, 1, 7);
    await ping;
    expect(onCursorAdvanced).toHaveBeenCalledTimes(1);
    expect(onCursorAdvanced).toHaveBeenCalledWith(7);

    // The same cursor again is not news.
    const second = session.ping();
    await answerNextHeartbeat(socket, 2, 7);
    await second;
    expect(onCursorAdvanced).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("does not fire when the ack cursor equals the known cursor", async () => {
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
    });

    const ping = session.ping();
    await answerNextHeartbeat(socket, 1, 0);
    await ping;
    expect(onCursorAdvanced).not.toHaveBeenCalled();
    session.close();
  });

  it("does not fire when the ack cursor was already delivered via cursor_advanced", async () => {
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
    });

    socket.emitMessage({ type: "cursor_advanced", cursor: 4 });
    expect(onCursorAdvanced).toHaveBeenCalledTimes(1);

    const ping = session.ping();
    await answerNextHeartbeat(socket, 1, 4);
    await ping;
    expect(onCursorAdvanced).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("ignores heartbeat acks without a cursor (older server)", async () => {
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
    });

    const ping = session.ping();
    await answerNextHeartbeat(socket, 1, undefined);
    await expect(ping).resolves.toBeUndefined();
    expect(onCursorAdvanced).not.toHaveBeenCalled();
    session.close();
  });

  it("checks the cursor on the periodic heartbeat as well", async () => {
    vi.useFakeTimers();
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
      clientOptions: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await answerNextHeartbeat(socket, 1, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(onCursorAdvanced).toHaveBeenCalledTimes(1);
    expect(onCursorAdvanced).toHaveBeenCalledWith(3);

    await vi.advanceTimersByTimeAsync(30_000);
    await answerNextHeartbeat(socket, 2, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(onCursorAdvanced).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("does not treat the device's own contiguous commits as missed broadcasts", async () => {
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
    });

    const commit = session.commitMutations([createMutation()]);
    await waitForSentMessage(socket, 1);
    socket.emitMessage({
      type: "commit_mutations_committed",
      requestId: socket.sentMessageAt(1).requestId,
      cursor: 1,
      results: [
        { status: "accepted", mutationId: "mutation-1", cursor: 1, entryId: "entry-1", revision: 1 },
      ],
    });
    await commit;

    for (let index = 2; index < 5; index += 1) {
      const ping = session.ping();
      await answerNextHeartbeat(socket, index, 1);
      await ping;
    }
    expect(onCursorAdvanced).not.toHaveBeenCalled();
    session.close();
  });

  it("still detects a missed remote commit that landed before the device's own commit", async () => {
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
    });

    // Another device committed cursor 1 while we were suspended (broadcast
    // lost); our own commit then became cursor 2.
    const commit = session.commitMutations([createMutation()]);
    await waitForSentMessage(socket, 1);
    socket.emitMessage({
      type: "commit_mutations_committed",
      requestId: socket.sentMessageAt(1).requestId,
      cursor: 2,
      results: [
        { status: "accepted", mutationId: "mutation-1", cursor: 2, entryId: "entry-1", revision: 1 },
      ],
    });
    await commit;

    const ping = session.ping();
    await answerNextHeartbeat(socket, 2, 2);
    await ping;
    expect(onCursorAdvanced).toHaveBeenCalledTimes(1);
    expect(onCursorAdvanced).toHaveBeenCalledWith(2);

    const again = session.ping();
    await answerNextHeartbeat(socket, 3, 2);
    await again;
    expect(onCursorAdvanced).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("defers the check while the device's own commit is in flight", async () => {
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
    });

    const commit = session.commitMutations([createMutation()]);
    await waitForSentMessage(socket, 1);
    const commitRequestId = socket.sentMessageAt(1).requestId;

    // Server already applied our commit; its heartbeat reply beats the commit reply.
    const ping = session.ping();
    await answerNextHeartbeat(socket, 2, 1);
    await ping;
    expect(onCursorAdvanced).not.toHaveBeenCalled();

    socket.emitMessage({
      type: "commit_mutations_committed",
      requestId: commitRequestId,
      cursor: 1,
      results: [
        { status: "accepted", mutationId: "mutation-1", cursor: 1, entryId: "entry-1", revision: 1 },
      ],
    });
    await commit;

    const after = session.ping();
    await answerNextHeartbeat(socket, 3, 1);
    await after;
    expect(onCursorAdvanced).not.toHaveBeenCalled();
    session.close();
  });

  it("folds acknowledged pull cursors into the known cursor", async () => {
    const onCursorAdvanced = vi.fn();
    const { socket, session } = await openRealtimeSession({
      callbacks: { onCursorAdvanced },
    });

    const ack = session.ackCursor(9);
    await waitForSentMessage(socket, 1);
    socket.emitMessage({
      type: "cursor_acked",
      requestId: socket.sentMessageAt(1).requestId,
      cursor: 9,
    });
    await ack;

    const ping = session.ping();
    await answerNextHeartbeat(socket, 2, 9);
    await ping;
    expect(onCursorAdvanced).not.toHaveBeenCalled();
    session.close();
  });
  describe("server cursor confirmation", () => {
    it("confirms the cursor when a heartbeat ack is not ahead of what we know", async () => {
      const onServerCursorConfirmed = vi.fn();
      const onCursorAdvanced = vi.fn();
      const { socket, session } = await openRealtimeSession({
        callbacks: { onCursorAdvanced, onServerCursorConfirmed },
      });

      const ping = session.ping();
      await answerNextHeartbeat(socket, 1, 0);
      await ping;
      expect(onServerCursorConfirmed).toHaveBeenCalledTimes(1);
      expect(onServerCursorConfirmed).toHaveBeenCalledWith(0);
      expect(onCursorAdvanced).not.toHaveBeenCalled();
      session.close();
    });

    it("does not confirm when the ack reveals a missed advance", async () => {
      const onServerCursorConfirmed = vi.fn();
      const { socket, session } = await openRealtimeSession({
        callbacks: { onServerCursorConfirmed },
      });

      const ping = session.ping();
      await answerNextHeartbeat(socket, 1, 3);
      await ping;
      expect(onServerCursorConfirmed).not.toHaveBeenCalled();
      session.close();
    });

    it("does not confirm acks without a cursor (older server)", async () => {
      const onServerCursorConfirmed = vi.fn();
      const { socket, session } = await openRealtimeSession({
        callbacks: { onServerCursorConfirmed },
      });

      const ping = session.ping();
      await answerNextHeartbeat(socket, 1, undefined);
      await ping;
      expect(onServerCursorConfirmed).not.toHaveBeenCalled();
      session.close();
    });

    it("does not confirm while the device's own commit is in flight", async () => {
      const onServerCursorConfirmed = vi.fn();
      const { socket, session } = await openRealtimeSession({
        callbacks: { onServerCursorConfirmed },
      });

      const commit = session.commitMutations([createMutation()]);
      await waitForSentMessage(socket, 1);
      const commitRequestId = socket.sentMessageAt(1).requestId;
      const ping = session.ping();
      await answerNextHeartbeat(socket, 2, 0);
      await ping;
      expect(onServerCursorConfirmed).not.toHaveBeenCalled();

      socket.emitMessage({
        type: "commit_mutations_committed",
        requestId: commitRequestId,
        cursor: 1,
        results: [
          { status: "accepted", mutationId: "mutation-1", cursor: 1, entryId: "entry-1", revision: 1 },
        ],
      });
      await commit;
      session.close();
    });
  });
});
