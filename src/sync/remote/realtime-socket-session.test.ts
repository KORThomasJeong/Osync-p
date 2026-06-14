import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForOpen } from "./realtime-socket-session";

type Listener = (event: unknown) => void;

class FakeSocket {
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener as Listener);
  }

  close(): void {
    this.closeCalls += 1;
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

describe("waitForOpen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects, closes the socket, and removes listeners when the open never arrives", async () => {
    const socket = new FakeSocket();
    const result = waitForOpen(socket.asWebSocket());
    const expectation = expect(result).rejects.toThrow(
      "sync websocket connection timed out before opening",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;

    expect(socket.closeCalls).toBe(1);
    expect(socket.listenerCount("open")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("resolves on open and the timeout never rejects afterwards", async () => {
    const socket = new FakeSocket();
    const result = waitForOpen(socket.asWebSocket());

    socket.dispatch("open");
    await expect(result).resolves.toBeUndefined();

    // The cleared timeout must not fire a late rejection or call close again.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBeUndefined();
    expect(socket.closeCalls).toBe(0);
    expect(socket.listenerCount("open")).toBe(0);
  });

  it("honours a custom timeout value", async () => {
    const socket = new FakeSocket();
    const result = waitForOpen(socket.asWebSocket(), 1_000);
    const expectation = expect(result).rejects.toThrow(
      "sync websocket connection timed out before opening",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;

    expect(socket.closeCalls).toBe(1);
  });
});
