export type SyncLoopState =
  | "stopped"
  | "connecting"
  | "live"
  | "draining"
  | "retry_wait"
  | "reconnect_wait"
  | "paused";

export type SyncConnectionState = "connecting" | "live" | "reconnecting";

// A loop-state bug, not a sync failure: the loop logs it instead of reporting it.
export class InvalidSyncTransitionError extends Error {
  constructor(from: SyncLoopState, to: SyncLoopState) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "InvalidSyncTransitionError";
  }
}

export class SyncAutoLoopState {
  private state: SyncLoopState = "stopped";

  constructor(
    private readonly onConnectionStateChange?: (state: SyncConnectionState) => void,
  ) {}

  get current(): SyncLoopState {
    return this.state;
  }

  isActive(): boolean {
    return this.state !== "stopped" && this.state !== "paused";
  }

  set(state: SyncLoopState): void {
    if (this.state === state) {
      return;
    }

    const previous = this.state;
    this.state = state;
    if (state === "connecting") {
      this.onConnectionStateChange?.("connecting");
      return;
    }
    if (state === "reconnect_wait") {
      this.onConnectionStateChange?.("reconnecting");
      return;
    }
    if (
      state === "live" &&
      (previous === "connecting" || previous === "reconnect_wait")
    ) {
      this.onConnectionStateChange?.("live");
    }
  }

  startConnecting(): void {
    if (
      this.state !== "stopped" &&
      this.state !== "paused" &&
      this.state !== "retry_wait" &&
      this.state !== "reconnect_wait" &&
      this.state !== "connecting"
    ) {
      throw new InvalidSyncTransitionError(this.state, "connecting");
    }
    this.set("connecting");
  }

  goLive(): void {
    if (this.state !== "connecting" && this.state !== "reconnect_wait") {
      throw new InvalidSyncTransitionError(this.state, "live");
    }
    this.set("live");
  }

  // A (re)connect is starting. A drain that is already running owns the state and
  // connects inline, so it stays "draining"; a live loop that lost its socket passes
  // through reconnect_wait so the move to "connecting" is a valid transition.
  beginConnecting(): void {
    if (this.state === "draining") {
      return;
    }
    if (this.state === "live") {
      this.waitForReconnect();
    }
    this.startConnecting();
  }

  // The socket is up. Only a loop that was waiting for it goes live; a drain or a
  // sync retry that is already scheduled keeps its state and decides what comes next.
  connectionEstablished(): void {
    if (
      this.state === "draining" ||
      this.state === "retry_wait" ||
      this.state === "live"
    ) {
      return;
    }
    this.goLive();
  }

  drain(): void {
    if (
      this.state !== "live" &&
      this.state !== "connecting" &&
      this.state !== "reconnect_wait" &&
      this.state !== "draining" &&
      this.state !== "retry_wait"
    ) {
      throw new InvalidSyncTransitionError(this.state, "draining");
    }
    this.set("draining");
  }

  pause(): void {
    this.set("paused");
  }

  resumeFromPause(): void {
    if (this.state !== "paused") {
      throw new InvalidSyncTransitionError(this.state, "live");
    }
    this.set("live");
  }

  stop(): void {
    this.set("stopped");
  }

  waitForRetry(): void {
    if (
      this.state !== "live" &&
      this.state !== "connecting" &&
      this.state !== "draining" &&
      this.state !== "retry_wait"
    ) {
      throw new InvalidSyncTransitionError(this.state, "retry_wait");
    }
    this.set("retry_wait");
  }

  waitForReconnect(): void {
    this.set("reconnect_wait");
  }
}
