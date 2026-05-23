import { describe, expect, it, vi } from "vitest";
import { SyncAutoLoopState } from "./auto-sync-state";

describe("SyncAutoLoopState 가드 전이", () => {
  it("stopped → connecting: startConnecting() 성공", () => {
    const state = new SyncAutoLoopState();
    state.startConnecting();
    expect(state.current).toBe("connecting");
  });

  it("stopped → live: startConnecting() 없이 goLive() 실패", () => {
    const state = new SyncAutoLoopState();
    expect(() => state.goLive()).toThrow();
  });

  it("connecting → live: goLive() 성공", () => {
    const state = new SyncAutoLoopState();
    state.startConnecting();
    state.goLive();
    expect(state.current).toBe("live");
  });

  it("live → paused: pause() 성공", () => {
    const state = new SyncAutoLoopState();
    state.startConnecting();
    state.goLive();
    state.pause();
    expect(state.current).toBe("paused");
  });

  it("live → draining: drain() 성공", () => {
    const state = new SyncAutoLoopState();
    state.startConnecting();
    state.goLive();
    state.drain();
    expect(state.current).toBe("draining");
  });

  it("onConnectionStateChange 콜백 호출", () => {
    const cb = vi.fn();
    const state = new SyncAutoLoopState(cb);
    state.startConnecting();
    expect(cb).toHaveBeenCalledWith("connecting");
    state.goLive();
    expect(cb).toHaveBeenCalledWith("live");
  });
});
