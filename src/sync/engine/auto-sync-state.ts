export type SyncLoopState =
  | "stopped"
  | "connecting"
  | "live"
  | "draining"
  | "retry_wait"
  | "reconnect_wait"
  | "paused";

export type SyncConnectionState = "connecting" | "live" | "reconnecting";

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
      throw new Error(`Invalid transition: ${this.state} → connecting`);
    }
    this.set("connecting");
  }

  goLive(): void {
    if (this.state !== "connecting" && this.state !== "reconnect_wait") {
      throw new Error(`Invalid transition: ${this.state} → live`);
    }
    this.set("live");
  }

  drain(): void {
    if (
      this.state !== "live" &&
      this.state !== "connecting" &&
      this.state !== "reconnect_wait" &&
      this.state !== "draining" &&
      this.state !== "retry_wait"
    ) {
      throw new Error(`Invalid transition: ${this.state} → draining`);
    }
    this.set("draining");
  }

  pause(): void {
    this.set("paused");
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
      throw new Error(`Invalid transition: ${this.state} → retry_wait`);
    }
    this.set("retry_wait");
  }

  waitForReconnect(): void {
    this.set("reconnect_wait");
  }
}
