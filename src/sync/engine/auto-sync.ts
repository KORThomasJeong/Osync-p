import type { SyncTokenResponse } from "../remote/client";
import type { PushPendingMutationsResult } from "./push-service";
import {
  SyncRealtimeClient,
  type SyncRealtimeSession,
  type SyncStorageStatus,
} from "../remote/realtime-client";
import type { SyncCursorStore } from "../store/ports";
import { SyncAutoLoopState, type SyncConnectionState } from "./auto-sync-state";
import { AutoSyncTimers } from "./auto-sync-timers";
import { PendingSyncWorkQueue } from "./auto-sync-work-queue";

const DEFAULT_PUSH_DEBOUNCE_MS = 750;
const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_SYNC_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_SYNC_RETRY_MAX_DELAY_MS = 30_000;
const RESUME_LIVENESS_PROBE_TIMEOUT_MS = 5_000;
// Heartbeats confirm the cursor every ~30s; only log one when it says something new.
const VERIFY_LOG_MIN_INTERVAL_MS = 5 * 60_000;

// The subset of activity-log kinds the loop itself reports.
export type AutoSyncActivityKind = "connect" | "disconnect" | "resume" | "verify";
type VerificationSource = "hello" | "pull" | "heartbeat";

export interface SyncAutoLoopDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncCursorStore | null;
  pushPendingMutations: (
    session: SyncRealtimeSession,
  ) => Promise<PushPendingMutationsResult>;
  pullOnce: (session: SyncRealtimeSession) => Promise<unknown>;
  realtimeClient?: SyncRealtimeClientLike;
  pushDebounceMs?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  syncRetryBaseDelayMs?: number;
  syncRetryMaxDelayMs?: number;
  onConnectionStateChange?: (state: SyncConnectionState) => void;
  onStorageStatusChange?: (status: SyncStorageStatus | null) => void;
  onSyncScheduled?: () => void;
  // A resume began re-checking the server; "up to date" is no longer known to hold.
  onVerificationStarted?: () => void;
  onIdle?: () => void;
  onError?: (error: unknown) => void;
  onActivity?: (kind: AutoSyncActivityKind, message: string) => void;
}

export interface SyncRealtimeClientLike {
  openSession: SyncRealtimeClient["openSession"];
}

export class SyncAutoLoop {
  private readonly realtimeClient: SyncRealtimeClientLike;
  private realtimeSession: SyncRealtimeSession | null = null;
  private connectPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private readonly timers = new AutoSyncTimers();
  private reconnectAttempt = 0;
  private pullRequestCount = 0;
  private syncRetryAttempt = 0;
  private readonly state: SyncAutoLoopState;
  private storageStatusWatching = false;
  private readonly pendingWork = new PendingSyncWorkQueue();
  private lastVerifiedAt: number | null = null;
  private lastLoggedVerification: { cursor: number; at: number } | null = null;

  constructor(private readonly deps: SyncAutoLoopDeps) {
    this.realtimeClient = deps.realtimeClient ?? new SyncRealtimeClient();
    this.state = new SyncAutoLoopState(deps.onConnectionStateChange);
  }

  async start(): Promise<boolean> {
    // A paused loop is left for resume(): starting it here would silently undo a
    // user (or delete-burst) pause whenever the app returns to the foreground.
    if (this.isActive() || this.state.current === "paused") {
      return false;
    }

    this.state.startConnecting();
    await this.ensureRealtimeSession();
    return true;
  }

  stop(): void {
    this.state.stop();
    this.pendingWork.clear();
    this.timers.clearAll();
    this.realtimeSession?.close();
    this.realtimeSession = null;
    this.lastVerifiedAt = null;
    this.lastLoggedVerification = null;
  }

  pause(): void {
    if (!this.isActive()) {
      return;
    }
    this.state.pause();
    this.timers.clearAll();
  }

  resume(): void {
    if (this.state.current !== "paused") {
      return;
    }
    this.state.resumeFromPause();
    // Treat it like a wake-up: the socket may have died while paused (its close is
    // ignored then) and cursor broadcasts may have been missed, so verify the socket
    // and catch up instead of reporting "up to date" from an empty local queue.
    void this.resumeConnection();
  }

  // Time of the last confirmation that we are caught up with the server cursor
  // (a completed pull, or a hello/ack whose cursor was not ahead). Null until then.
  getLastVerifiedAt(): number | null {
    return this.lastVerifiedAt;
  }

  markVerified(): void {
    this.lastVerifiedAt = Date.now();
  }

  // Started and not stopped (a paused loop counts as started).
  isStarted(): boolean {
    return this.state.current !== "stopped";
  }

  // Push queued local mutations now instead of waiting for the debounce (e.g. the
  // app is being hidden and may be suspended before the timer fires).
  async flushPendingPush(): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    this.timers.clear("push");
    this.requestPush();
    await this.drain();
  }

  getMaxFileSizeBytes(): number {
    return this.realtimeSession?.maxFileSizeBytes ?? 0;
  }

  notifyLocalChange(): void {
    if (!this.isActive()) {
      return;
    }

    this.deps.onSyncScheduled?.();
    this.timers.set("push", () => {
      this.requestPush();
      void this.drain();
    }, this.deps.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS);
  }

  requestPull(targetCursor: number | null = null): void {
    if (this.state.current === "paused") {
      // Keep the target so resume() pulls it; dropping it here is how a paused loop
      // came back claiming "up to date" while changes were waiting on the server.
      this.requestPullWork(targetCursor);
      return;
    }
    if (!this.isActive()) {
      return;
    }

    this.deps.onSyncScheduled?.();
    this.requestPullWork(targetCursor);
    void this.drain();
  }

  setStorageStatusWatching(enabled: boolean): void {
    if (this.storageStatusWatching === enabled) {
      return;
    }

    this.storageStatusWatching = enabled;
    if (!enabled) {
      this.deps.onStorageStatusChange?.(null);
    }
    this.applyStorageStatusWatch();
  }

  async ensureRealtimeSession(): Promise<void> {
    if (!this.isActive() || this.realtimeSession || this.connectPromise) {
      return await (this.connectPromise ?? Promise.resolve());
    }

    this.connectPromise = this.openRealtimeSession();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async withRealtimeSession<T>(
    work: (session: SyncRealtimeSession) => Promise<T>,
  ): Promise<T> {
    if (!this.isActive()) {
      this.state.set("live");
    }

    await this.ensureRealtimeSession();
    const session = this.realtimeSession;
    if (!session) {
      throw new Error("Sync realtime session is not connected.");
    }

    return await work(session);
  }

  reconnectNow(): void {
    if (!this.isActive()) {
      return;
    }

    this.timers.clear("reconnect");
    this.markRealtimeDisconnected(false, "Reconnect requested");
    void this.ensureRealtimeSession();
  }

  async resumeConnection(): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    this.deps.onVerificationStarted?.();
    this.reportActivity("resume", "Resume: verifying connection");
    const pullRequestsBeforeProbe = this.pullRequestCount;
    if (this.realtimeSession && !(await this.isRealtimeSessionAlive())) {
      // Woken from sleep holding a socket the server already dropped: its idle
      // timeout expires while the device is suspended and our heartbeat timer is
      // frozen, so the session object outlives the connection. Trusting it here
      // would leave sync silently dead until the next heartbeat tick times out.
      this.markRealtimeDisconnected(false, "Liveness ping failed; reconnecting");
    }
    if (!this.isActive()) {
      return;
    }

    // A wake-up is a fresh start, not the next step of a backoff ladder.
    this.reconnectAttempt = 0;
    this.timers.clear("reconnect");
    this.resetSyncRetry();
    const keptSession = this.realtimeSession !== null;
    await this.ensureRealtimeSession();
    if (!this.isActive() || !this.realtimeSession) {
      // Reconnect is scheduled; the new session's hello cursor decides the pull.
      return;
    }

    if (keptSession && this.pullRequestCount === pullRequestsBeforeProbe) {
      // A surviving socket proves nothing about broadcasts sent while we were
      // suspended. A pull from the stored cursor is cheap when nothing changed.
      // Skipped when the probe's heartbeat_ack already revealed a missed cursor
      // and queued a pull — that pull started after the probe and covers it.
      this.requestPullWork(null);
    }
    if (this.hasPendingWork() || this.drainPromise) {
      await this.drain();
    }
  }

  private async isRealtimeSessionAlive(): Promise<boolean> {
    const session = this.realtimeSession;
    if (!session) {
      return false;
    }

    try {
      await session.ping(RESUME_LIVENESS_PROBE_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  private async openRealtimeSession(): Promise<void> {
    try {
      if (this.state.current === "live") {
        // Reconnecting after an unexpected session loss (e.g. the store DB was
        // deleted during a reset, closing the socket while the loop stayed
        // "live"). Move through reconnect_wait so startConnecting is a valid
        // transition instead of throwing "Invalid transition: live → connecting".
        this.state.waitForReconnect();
      }
      this.state.startConnecting();
      const store = this.deps.getSyncStore();
      if (!store) {
        throw new Error("Sync store is not initialized.");
      }

      const token = await this.deps.getSyncToken();
      const cursor = await store.getCursor();
      const session = await this.realtimeClient.openSession(
        this.deps.getApiBaseUrl(),
        token,
        cursor,
        {
          onCursorAdvanced: (nextCursor) => {
            this.requestPull(nextCursor);
          },
          onStorageStatusUpdated: (status) => {
            this.deps.onStorageStatusChange?.(status);
          },
          onClose: () => {
            this.markRealtimeDisconnected(true, "Socket closed");
          },
          onServerCursorConfirmed: (confirmedCursor) => {
            void this.confirmServerCursor(confirmedCursor);
          },
          onError: (error) => {
            this.handleError(error);
          },
        },
      );
      if (!this.isActive()) {
        session.close();
        return;
      }

      this.realtimeSession = session;
      this.reconnectAttempt = 0;
      if (this.storageStatusWatching) {
        this.applyStorageStatusWatch();
      }
      this.reportActivity(
        "connect",
        `Connected (cursor local ${cursor} → server ${session.serverCursor})`,
      );
      if (session.serverCursor > cursor) {
        this.deps.onSyncScheduled?.();
        this.requestPullWork(session.serverCursor);
      } else {
        this.recordVerification(session.serverCursor, "hello");
      }
      this.state.goLive();
      if (this.hasPendingWork()) {
        void this.drain();
      } else {
        this.deps.onIdle?.();
      }
    } catch (error) {
      this.handleError(error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isActive() || this.timers.has("reconnect")) {
      return;
    }

    this.state.waitForReconnect();
    const baseDelay = this.deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxDelay = this.deps.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** this.reconnectAttempt, maxDelay);
    this.reconnectAttempt += 1;
    this.timers.set("reconnect", () => {
      void this.ensureRealtimeSession();
    }, delay);
  }

  private markRealtimeDisconnected(scheduleReconnect = true, reason?: string): void {
    if (!this.isActive()) {
      return;
    }

    const session = this.realtimeSession;
    if (session && reason) {
      this.reportActivity("disconnect", reason);
    }
    this.realtimeSession = null;
    this.deps.onStorageStatusChange?.(null);
    session?.close();
    if (scheduleReconnect) {
      this.scheduleReconnect();
    }
  }

  private applyStorageStatusWatch(): void {
    const session = this.realtimeSession;
    if (!session) {
      return;
    }

    try {
      if (this.storageStatusWatching) {
        session.watchStorageStatus();
      } else {
        session.unwatchStorageStatus();
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private async drain(): Promise<void> {
    if (!this.isActive() || this.drainPromise) {
      return await (this.drainPromise ?? Promise.resolve());
    }
    this.drainPromise = this.runDrainLoop();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
      if (
        this.isActive() &&
        this.hasPendingWork() &&
        !this.timers.has("reconnect") &&
        !this.timers.has("syncRetry")
      ) {
        void this.drain();
      }
    }

    if (
      this.isActive() &&
      !this.hasPendingWork() &&
      !this.timers.has("reconnect") &&
      !this.timers.has("syncRetry")
    ) {
      this.state.set("live");
      this.deps.onIdle?.();
    }
  }

  private async runDrainLoop(): Promise<void> {
    this.state.drain();
    while (this.isActive() && this.hasPendingWork()) {
      const work = this.takePendingWork();
      const shouldPush = work.push;
      const shouldPull = work.pullTargetCursor !== null;

      let shouldPullNow = shouldPull;
      let pushCompleted = !shouldPush;
      try {
        let session: SyncRealtimeSession | null = null;
        if (shouldPush || shouldPullNow) {
          await this.ensureRealtimeSession();
          session = this.realtimeSession;
          if (!session) {
            if (shouldPush) {
              this.requestPush();
            }
            if (shouldPullNow) {
              this.requestPullWork(work.pullTargetCursor);
            }
            if (!this.timers.has("reconnect")) {
              this.scheduleSyncRetry();
            }
            return;
          }
        }

        if (shouldPullNow) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          this.recordVerification(
            cursorOfPullResult(await this.deps.pullOnce(session)),
            "pull",
          );
          shouldPullNow = false;
        }
        if (shouldPush) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          const pushResult = await this.deps.pushPendingMutations(session);
          pushCompleted = true;
          shouldPullNow = shouldPullNow || pushResult.shouldPullAfterPush;
          if (pushResult.hasMore) {
            this.requestPush();
          }
        }
        if (shouldPullNow) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          this.recordVerification(
            cursorOfPullResult(await this.deps.pullOnce(session)),
            "pull",
          );
        }
        this.resetSyncRetry();
      } catch (error) {
        if (shouldPush && !pushCompleted) {
          this.requestPush();
        }
        if (shouldPullNow) {
          this.requestPullWork(work.pullTargetCursor);
        }
        this.handleError(error);
        this.scheduleSyncRetry();
        return;
      }
    }
  }

  private scheduleSyncRetry(): void {
    if (!this.isActive() || this.timers.has("syncRetry")) {
      return;
    }

    this.state.waitForRetry();
    const baseDelay = this.deps.syncRetryBaseDelayMs ?? DEFAULT_SYNC_RETRY_BASE_DELAY_MS;
    const maxDelay = this.deps.syncRetryMaxDelayMs ?? DEFAULT_SYNC_RETRY_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** this.syncRetryAttempt, maxDelay);
    this.syncRetryAttempt += 1;
    this.timers.set("syncRetry", () => {
      if (!this.isActive() || !this.hasPendingWork()) {
        return;
      }

      this.deps.onSyncScheduled?.();
      void this.drain();
    }, delay);
  }

  private resetSyncRetry(): void {
    this.syncRetryAttempt = 0;
    this.timers.clear("syncRetry");
  }

  private isActive(): boolean {
    return this.state.isActive();
  }

  private requestPush(): void {
    this.pendingWork.requestPush();
  }

  private requestPullWork(targetCursor: number | null): void {
    this.pullRequestCount += 1;
    this.pendingWork.requestPull(targetCursor);
  }

  private hasPendingWork(): boolean {
    return this.pendingWork.hasPendingWork();
  }

  private takePendingWork() {
    return this.pendingWork.takePendingWork();
  }

  private handleError(error: unknown): void {
    this.deps.onError?.(error);
  }

  // A heartbeat ack reported a server cursor the session already knew. It proves we
  // are caught up only if nothing is still waiting to be pulled and the stored
  // cursor has actually reached it.
  private async confirmServerCursor(cursor: number): Promise<void> {
    if (!this.canConfirmServerCursor()) {
      return;
    }
    const store = this.deps.getSyncStore();
    if (!store) {
      return;
    }
    let localCursor: number;
    try {
      localCursor = await store.getCursor();
    } catch {
      return;
    }
    if (localCursor < cursor || !this.canConfirmServerCursor()) {
      return;
    }
    this.recordVerification(cursor, "heartbeat");
  }

  private canConfirmServerCursor(): boolean {
    return (
      this.isActive() &&
      this.pendingWork.pullTargetCursor === null &&
      this.drainPromise === null
    );
  }

  private recordVerification(cursor: number | null, source: VerificationSource): void {
    this.markVerified();
    if (cursor === null) {
      return;
    }
    const at = this.lastVerifiedAt ?? Date.now();
    const previous = this.lastLoggedVerification;
    // Connects and pulls already log their cursor; only heartbeats get their own
    // line, and only when the cursor moved or a while has passed.
    const shouldLog =
      source === "heartbeat" &&
      (previous === null ||
        previous.cursor !== cursor ||
        at - previous.at >= VERIFY_LOG_MIN_INTERVAL_MS);
    if (source !== "heartbeat" || shouldLog) {
      this.lastLoggedVerification = { cursor, at };
    }
    if (shouldLog) {
      this.reportActivity("verify", `Heartbeat confirmed server cursor ${cursor}`);
    }
  }

  private reportActivity(kind: AutoSyncActivityKind, message: string): void {
    try {
      this.deps.onActivity?.(kind, message);
    } catch {
      // Diagnostics must never break sync.
    }
  }
}

function cursorOfPullResult(result: unknown): number | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const cursor = (result as { cursor?: unknown }).cursor;
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : null;
}
