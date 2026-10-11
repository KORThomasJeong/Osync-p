import { Notice, Platform, type Plugin } from "obsidian";

import type { SyncCryptoService } from "../core/crypto-service";
import type { SyncTokenResponse } from "../remote/client";
import type {
  EntryVersion,
  EntryVersionPageCursor,
  SyncStorageStatus,
} from "../remote/realtime-client";
import type { SyncFileRules } from "../core/file-rules";
import {
  clearDexieSyncStore,
  createDexieSyncStore,
  readDexieSyncStoreConnection,
} from "../store/dexie";
import type { DeletedSyncEntryRow, SyncConnection } from "../store/store";
import type { SyncStoreCorruptionListener } from "../store/ports";
import { MassDeleteGuardError } from "../engine/mass-delete-guard";
import { classifyReconnectError } from "../remote/reconnect-error";
import { SyncConflictQueue } from "./conflict-queue";
import {
  type InitialCollisionPreview,
  SyncEngine,
  type SyncEngineEntryVersionsPage,
} from "./engine";
import { UserVisibleSyncStatusTracker } from "./user-visible-status-tracker";
import {
  describeActivityError,
  SyncActivityLog,
  type SyncActivityEntry,
  type SyncActivityLogStorage,
} from "./activity-log";
import type {
  UserVisibleSyncProgress,
  UserVisibleSyncState,
} from "./user-visible-status";
import {
  DeviceSyncIssues,
  type DeviceSyncIssuesStorage,
  type PortabilityWarning,
  type UnwritablePathEntry,
} from "./device-sync-issues";
import type { DevicePlatform } from "../core/path-portability";
import { RemoteVaultKeyMismatchError } from "../../remote-vault/types";
import type {
  UnreadableRemoteEntry,
  UnreadableRemovalResult,
  UnreadableScanResult,
} from "../engine/unreadable-entries";

export type {
  UnreadableRemoteEntry,
  UnreadableRemovalResult,
  UnreadableScanResult,
} from "../engine/unreadable-entries";

export type {
  DeviceSyncIssuesStorage,
  PortabilityWarning,
  UnwritablePathEntry,
} from "./device-sync-issues";

export type { InitialCollisionPreview } from "./engine";
export type { SyncActivityEntry, SyncActivityLogStorage } from "./activity-log";

export type {
  ConflictQueueItem,
  ConflictQueueSource,
} from "./conflict-queue";

// Startup retry after a transient failure (e.g. launched offline). Connectivity
// events also retry, but a device that stays in the foreground may never fire one.
const STARTUP_RETRY_BASE_DELAY_MS = 5_000;
const STARTUP_RETRY_MAX_DELAY_MS = 60_000;
// Window focus fires resume constantly on desktop; the local scan only needs to
// catch edits made outside Obsidian while it was backgrounded.
const RESUME_RECONCILE_MIN_INTERVAL_MS = 30_000;
// flushPendingNow runs while the app is being hidden; don't hold the caller longer
// than the OS is likely to keep us alive. The push itself keeps going in the background.
const FLUSH_MAX_WAIT_MS = 10_000;

export interface MassDeleteGuardEvent {
  deleteCount: number;
  knownEntryCount: number;
}

export interface SyncControllerDeps {
  plugin: Plugin;
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  invalidateSyncToken: () => void;
  crypto: SyncCryptoService;
  getSyncFileRules: () => SyncFileRules;
  hasActiveRemoteVaultSession: () => boolean;
  hasAuthenticatedSession: () => boolean;
  notifyError: (error: unknown, prefix: string) => void;
  notify?: (message: string, timeout?: number) => void;
  notifyMassDeleteGuard?: (event: MassDeleteGuardEvent) => void;
  onStatusChange?: () => void;
  // Persists the sync activity log across restarts; in-memory only when omitted.
  activityLogStorage?: SyncActivityLogStorage;
  // Persists the "not synced to this device" list; in-memory only when omitted.
  unwritablePathsStorage?: DeviceSyncIssuesStorage;
  // Persists the ids of server entries this device's key cannot decrypt.
  unreadableEntriesStorage?: DeviceSyncIssuesStorage;
  // The server refused this device's vault key. Sync is stopped; the user must
  // re-enter the vault password.
  onVaultKeyMismatch?: () => void;
  // Defaults to Obsidian's Platform (Windows rejects some file names).
  platform?: DevicePlatform;
}

export class SyncController {
  private readonly statusTracker = new UserVisibleSyncStatusTracker(() =>
    this.deps.onStatusChange?.(),
  );
  private readonly activityLog = new SyncActivityLog({
    storage: this.deps.activityLogStorage,
  });
  private readonly deviceSyncIssues = new DeviceSyncIssues({
    platform: this.deps.platform ?? { isWin: Platform.isWin },
    storage: this.deps.unwritablePathsStorage,
    unreadableStorage: this.deps.unreadableEntriesStorage,
  });
  private readonly syncEngine = new SyncEngine({
    plugin: this.deps.plugin,
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    invalidateSyncToken: () => this.deps.invalidateSyncToken(),
    crypto: this.deps.crypto,
    getSyncFileRules: () => this.deps.getSyncFileRules(),
    hasActiveRemoteVaultSession: () => this.deps.hasActiveRemoteVaultSession(),
    notify: (message, timeout) => this.notify(message, timeout),
    notifyError: (error, prefix) => this.deps.notifyError(error, prefix),
    notifySyncConflict: (event) => this.notifySyncConflict(event),
    setSyncProgress: (progress) => this.statusTracker.setProgress(progress),
    setSyncStatus: (status) => this.statusTracker.setStatus(status),
    setStorageStatus: (status) => this.statusTracker.setStorageStatus(status),
    recordActivity: (kind, message) => this.activityLog.record(kind, message),
    deviceSyncIssues: this.deviceSyncIssues,
    onVaultKeyMismatch: () => this.deps.onVaultKeyMismatch?.(),
  });
  private readonly conflictQueue = new SyncConflictQueue();
  private startupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private startupRetryAttempt = 0;
  // Mirrors the user's pause so a startup retry that starts the loop re-applies it.
  private autoSyncPaused = false;
  private lastReconcileAt: number | null = null;

  constructor(private readonly deps: SyncControllerDeps) {}

  getConflictQueue(): SyncConflictQueue {
    return this.conflictQueue;
  }

  setStoreCorruptionListener(listener: SyncStoreCorruptionListener | null): void {
    this.syncEngine.setStoreCorruptionListener(listener);
  }

  async readStoredConnection(): Promise<SyncConnection | null> {
    return await readDexieSyncStoreConnection(this.deps.plugin);
  }

  async initializeStore(
    remoteVaultId: string,
    initialSyncMode?: "download" | "merge",
  ): Promise<void> {
    try {
      await this.syncEngine.closeStore();
      this.syncEngine.setStore(await createDexieSyncStore(this.deps.plugin));
      await this.syncEngine.getOrCreateLocalVaultId(remoteVaultId, initialSyncMode);
      await this.syncEngine.refreshSyncProgress();
    } catch (error) {
      this.statusTracker.setStatus("attention_needed");
      this.deps.notifyError(error, "Local sync store initialization failed");
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.cancelStartupRetry();
    this.syncEngine.stopAutoSync();
    this.activityLog.flush();
    await this.syncEngine.closeStore();
  }

  // Newest last.
  getActivityLog(): readonly SyncActivityEntry[] {
    return this.activityLog.getEntries();
  }

  onActivityLogChange(listener: () => void): () => void {
    return this.activityLog.onChange(listener);
  }

  clearActivityLog(): void {
    this.activityLog.clear();
  }

  // Remote files this device skipped (a name it cannot hold, a path over the limits)
  // or failed to write. They stay intact on the server and on other devices.
  getUnwritablePaths(): readonly UnwritablePathEntry[] {
    return this.deviceSyncIssues.getUnwritablePaths();
  }

  // Local files that upload fine but cannot be opened on Windows devices.
  getPortabilityWarnings(): readonly PortabilityWarning[] {
    return this.deviceSyncIssues.getPortabilityWarnings();
  }

  // Server entries this device's vault key cannot decrypt (quarantined by the pull,
  // or found by a full scan). Changes are reported via onDeviceSyncIssuesChange.
  getUnreadableEntryCount(): number {
    return this.deviceSyncIssues.getUnreadableEntryCount();
  }

  onDeviceSyncIssuesChange(listener: () => void): () => void {
    return this.deviceSyncIssues.onChange(listener);
  }

  async scanUnreadableEntries(
    onProgress?: (scanned: number, total: number) => void,
  ): Promise<UnreadableScanResult & { knownLocally: string[] }> {
    this.requireSyncReady();
    const result = await this.syncEngine.scanUnreadableRemoteEntries(onProgress);
    this.activityLog.record(
      "resume",
      `Key check: ${result.unreadable.length} of ${result.scannedEntries} server entries can't be decrypted`,
    );
    return result;
  }

  async removeUnreadableEntries(
    targets: readonly UnreadableRemoteEntry[],
  ): Promise<UnreadableRemovalResult> {
    this.requireSyncReady();
    return await this.syncEngine.removeUnreadableRemoteEntries(targets);
  }

  async reuploadUnreadableLocalEntries(entryIds: readonly string[]): Promise<number> {
    this.requireSyncReady();
    return await this.syncEngine.reuploadUnreadableLocalEntries(entryIds);
  }

  private requireSyncReady(): void {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in first.");
    }
    if (!this.syncEngine.hasStore()) {
      throw new Error("Local sync store is not initialized.");
    }
  }

  // Re-attempts the files whose write failed on this device, then runs a catch-up
  // check. Paths this device can never hold (e.g. Windows-invalid names) stay listed.
  // Never throws; failures are listed again and logged.
  async retryUnwritablePaths(): Promise<void> {
    try {
      const result = await this.syncEngine.retryUnwritablePaths();
      if (result.retried > 0) {
        this.activityLog.record(
          "resume",
          `Retried ${result.retried} unwritten file${result.retried === 1 ? "" : "s"}: ${
            result.retried - result.failed
          } written, ${result.failed} failed`,
        );
      }
    } catch (error) {
      this.activityLog.record("error", `Retry failed: ${describeActivityError(error)}`);
      this.deps.notifyError(error, "Retry failed");
      return;
    }
    await this.checkNow();
  }

  // Count of local changes recorded but not yet accepted by the server.
  async getPendingUploadCount(): Promise<number> {
    try {
      return await this.syncEngine.countPendingMutations();
    } catch (error) {
      console.warn("[osync] failed to count pending uploads", error);
      return 0;
    }
  }

  // The app is being hidden (mobile backgrounding, window blur): push queued local
  // edits now instead of after the debounce, since the OS may suspend us first.
  // Resolves within FLUSH_MAX_WAIT_MS even if the push is still running.
  async flushPendingNow(): Promise<void> {
    try {
      await this.syncEngine.waitForLocalMutationWork();
      const pending = await this.syncEngine.countPendingMutations();
      if (pending === 0 || this.autoSyncPaused || !this.syncEngine.isAutoSyncStarted()) {
        return;
      }

      this.activityLog.record("flush", `Flushing ${pending} pending uploads`);
      await waitAtMost(this.syncEngine.flushPendingPush(), FLUSH_MAX_WAIT_MS);
    } catch (error) {
      this.activityLog.record("error", `Flush failed: ${describeActivityError(error)}`);
    } finally {
      this.activityLog.flush();
    }
  }

  // User-requested full verification: like a resume (ping, reconnect if dead,
  // catch-up pull) but with a fresh local scan and fresh backoffs. Never throws;
  // failures show up in the sync status and the activity log.
  async checkNow(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      return;
    }

    try {
      if (
        !this.syncEngine.hasStore() ||
        this.startupRetryTimer !== null ||
        !this.syncEngine.isAutoSyncStarted()
      ) {
        this.activityLog.record("resume", "Manual check: starting sync");
        this.cancelStartupRetry();
        await this.ensureAutoSyncState();
        return;
      }
      if (this.autoSyncPaused) {
        this.activityLog.record("resume", "Manual check skipped: sync is paused");
        return;
      }

      this.activityLog.record("resume", "Manual check");
      if (this.statusTracker.getState() !== "attention_needed") {
        // An escalated failure stays visible until the check actually succeeds.
        this.statusTracker.setStatus("checking");
      }
      this.lastReconcileAt = null;
      if (!(await this.reconcileAfterResume())) {
        return;
      }
      const started = await this.syncEngine.startAutoSync();
      if (!started) {
        await this.syncEngine.resumeAutoSyncConnection();
      }
    } catch (error) {
      this.activityLog.record("error", `Manual check failed: ${describeActivityError(error)}`);
      this.statusTracker.setStatus("attention_needed");
      this.deps.notifyError(error, "Sync check failed");
    } finally {
      this.activityLog.flush();
    }
  }

  async readLocalVaultId(): Promise<string> {
    return await this.syncEngine.readLocalVaultId();
  }

  async getOrCreateLocalVaultId(remoteVaultId: string): Promise<string> {
    return await this.syncEngine.getOrCreateLocalVaultId(remoteVaultId);
  }

  stopAutoSyncAndMarkNotReady(): void {
    this.cancelStartupRetry();
    this.syncEngine.stopAutoSync();
    this.statusTracker.setStorageStatus(null);
    this.statusTracker.setProgress({
      completedEntries: 0,
      totalEntries: 0,
    });
    this.statusTracker.setStatus("not_ready");
  }

  async countExcludedRemoteEntries(): Promise<number> {
    return await this.syncEngine.countExcludedRemoteEntries();
  }

  async purgeExcludedRemoteEntries(): Promise<number> {
    return await this.syncEngine.purgeExcludedRemoteEntries();
  }

  pauseAutoSync(): void {
    this.autoSyncPaused = true;
    this.syncEngine.pauseAutoSync();
  }

  resumeAutoSyncFromPause(): void {
    this.autoSyncPaused = false;
    this.syncEngine.resumeAutoSyncFromPause();
    // Edits made while paused were recorded but never scheduled (notifyLocalChange
    // is a no-op while paused), so they would otherwise wait for the next edit.
    void this.syncEngine.hasPendingMutations().then(
      (hasPendingMutations) => {
        if (hasPendingMutations) {
          this.syncEngine.notifyLocalChange();
        }
      },
      () => {},
    );
  }

  async resetLocalSyncState(opts?: { preserveLocalVaultId?: boolean }): Promise<void> {
    this.cancelStartupRetry();
    this.syncEngine.stopAutoSync();
    // Let any in-flight pull/push and queued local work settle before detaching and
    // deleting the store, so nothing keeps writing to a store being torn down.
    await this.syncEngine.drainInFlightSync();
    this.statusTracker.setStorageStatus(null);
    const store = this.syncEngine.detachStore();
    try {
      await store?.close();
    } catch {
      // Continue clearing persisted sync state even if flushing the old store fails.
    }
    await clearDexieSyncStore(this.deps.plugin, opts);
    this.statusTracker.setProgress({
      completedEntries: 0,
      totalEntries: 0,
    });
    this.statusTracker.setStatus("not_ready");
  }

  getSyncStatusLabel(): string {
    return this.statusTracker.getStatusLabel();
  }

  getSyncState(): UserVisibleSyncState {
    return this.statusTracker.getState();
  }

  getSyncPercent(): number {
    return this.statusTracker.getDisplayPercent();
  }

  getSyncProgress(): UserVisibleSyncProgress {
    return this.statusTracker.getProgress();
  }

  getStorageStatus(): SyncStorageStatus | null {
    return this.statusTracker.getStorageStatus();
  }

  // When the server cursor was last confirmed (completed pull or a hello that was
  // not ahead); null before the first confirmation. For "last checked N min ago".
  getLastVerifiedAt(): number | null {
    return this.syncEngine.getLastVerifiedAt();
  }

  getMaxFileSizeBytes(): number {
    return this.syncEngine.getMaxFileSizeBytes();
  }

  watchStorageStatus(): void {
    this.syncEngine.setStorageStatusWatching(true);
  }

  unwatchStorageStatus(): void {
    this.syncEngine.setStorageStatusWatching(false);
  }

  async ensureAutoSyncState(): Promise<void> {
    // This attempt supersedes any scheduled retry; a failure below reschedules it.
    this.clearStartupRetryTimer();
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      this.cancelStartupRetry();
      this.syncEngine.stopAutoSync();
      this.statusTracker.setStorageStatus(null);
      this.statusTracker.setProgress({
        completedEntries: 0,
        totalEntries: 0,
      });
      this.statusTracker.setStatus("not_ready");
      return;
    }

    try {
      await this.syncEngine.runInitialPullIfRequired();
      const reconcile = await this.syncEngine.reconcileOnce();
      this.lastReconcileAt = Date.now();
      this.recordScan("Startup scan", reconcile);
      await this.syncEngine.waitForLocalMutationWork();
      await this.syncEngine.startAutoSync();
      this.startupRetryAttempt = 0;
      if (this.autoSyncPaused) {
        this.syncEngine.pauseAutoSync();
      }
      const hasPendingMutations = await this.syncEngine.hasPendingMutations();
      if (
        hasPendingMutations ||
        reconcile.filesQueuedForUpsert > 0 ||
        reconcile.filesQueuedForDelete > 0
      ) {
        this.syncEngine.notifyLocalChange();
      }
    } catch (error) {
      if (error instanceof MassDeleteGuardError) {
        this.cancelStartupRetry();
        this.handleMassDeleteGuard(error);
        return;
      }
      if (error instanceof RemoteVaultKeyMismatchError) {
        this.cancelStartupRetry();
        this.syncEngine.stopAutoSync();
        this.activityLog.record("error", "Sync stopped: the server refused this device's vault key");
        this.statusTracker.setStatus("attention_needed");
        this.deps.onVaultKeyMismatch?.();
        return;
      }
      const classification = classifyReconnectError(error);
      if (classification.kind === "transient") {
        // Likely offline at startup; retry quietly with backoff (connectivity
        // events may also retry sooner).
        this.statusTracker.setStatus("reconnecting");
        this.scheduleStartupRetry();
        return;
      }
      this.cancelStartupRetry();
      this.statusTracker.setStatus("attention_needed");
      this.deps.notifyError(error, "Auto sync initialization failed");
    }
  }

  private scheduleStartupRetry(): void {
    if (this.startupRetryTimer !== null) {
      return;
    }

    const delay = Math.min(
      STARTUP_RETRY_BASE_DELAY_MS * 2 ** this.startupRetryAttempt,
      STARTUP_RETRY_MAX_DELAY_MS,
    );
    this.startupRetryAttempt += 1;
    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = null;
      void this.ensureAutoSyncState();
    }, delay);
  }

  private clearStartupRetryTimer(): void {
    if (this.startupRetryTimer === null) {
      return;
    }

    clearTimeout(this.startupRetryTimer);
    this.startupRetryTimer = null;
  }

  private cancelStartupRetry(): void {
    this.clearStartupRetryTimer();
    this.startupRetryAttempt = 0;
  }

  private recordScan(
    label: string,
    result: { filesScanned: number; filesQueuedForUpsert: number; filesQueuedForDelete: number },
  ): void {
    this.activityLog.record(
      "scan",
      `${label}: ${result.filesQueuedForUpsert} upserts, ${result.filesQueuedForDelete} deletes queued (${result.filesScanned} scanned)`,
    );
  }

  private handleMassDeleteGuard(error: MassDeleteGuardError): void {
    this.activityLog.record(
      "error",
      `Mass delete guard: ${error.deleteCount} of ${error.knownEntryCount} entries would be deleted`,
    );
    this.statusTracker.setStatus("attention_needed");
    this.deps.notifyMassDeleteGuard?.({
      deleteCount: error.deleteCount,
      knownEntryCount: error.knownEntryCount,
    });
  }

  async previewInitialCollisions(): Promise<InitialCollisionPreview[]> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      return [];
    }
    if (!this.syncEngine.hasStore()) {
      return [];
    }
    return await this.syncEngine.previewInitialCollisions();
  }

  async applyInitialCollisionResolution(
    collisions: ReadonlyArray<InitialCollisionPreview>,
    policy: "server-wins" | "local-wins" | "timestamp",
  ): Promise<void> {
    if (collisions.length === 0) {
      return;
    }
    const winnerIsLocal = (collision: InitialCollisionPreview): boolean => {
      if (policy === "server-wins") return false;
      if (policy === "local-wins") return true;
      const serverTime = collision.remoteEditedAt ?? collision.remoteUpdatedAt;
      return collision.localMtime > serverTime;
    };
    const localWinPaths = collisions
      .filter(winnerIsLocal)
      .map((c) => c.path);
    const cached = await this.syncEngine.cacheCollisionBytes(localWinPaths);

    await this.ensureAutoSyncState();

    for (const [path, info] of cached) {
      try {
        await this.syncEngine.writeBackLocalCollision(path, info.bytes);
      } catch (error) {
        this.deps.notifyError(error, `Failed to restore local content at ${path}`);
      }
    }
    if (cached.size > 0) {
      try {
        await this.syncEngine.reconcileOnce();
        this.syncEngine.notifyLocalChange();
      } catch (error) {
        this.deps.notifyError(error, "Initial collision reconcile failed");
      }
    }
  }

  async restoreVaultFromServer(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      return;
    }
    try {
      this.syncEngine.stopAutoSync();
      await this.syncEngine.drainInFlightSync();
      await this.syncEngine.wipeLocalEntriesForRestore();
      this.statusTracker.setStatus("syncing");
      await this.ensureAutoSyncState();
    } catch (error) {
      this.statusTracker.setStatus("attention_needed");
      this.deps.notifyError(error, "Restore from server failed");
    }
  }

  async confirmMassDelete(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      return;
    }
    try {
      this.statusTracker.setStatus("syncing");
      await this.syncEngine.reconcileOnce({ allowMassDelete: true });
      await this.syncEngine.startAutoSync();
      this.syncEngine.notifyLocalChange();
    } catch (error) {
      this.statusTracker.setStatus("attention_needed");
      this.deps.notifyError(error, "Mass delete commit failed");
    }
  }

  async resumeAutoSync(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      return;
    }

    if (!this.syncEngine.hasStore() || this.startupRetryTimer !== null) {
      // Startup never completed (initial pull / reconcile included): run it in full.
      await this.ensureAutoSyncState();
      return;
    }

    if (!this.autoSyncPaused && this.statusTracker.getState() === "up_to_date") {
      // Stale until this resume re-checks the server; don't keep claiming it.
      this.statusTracker.setStatus("checking");
    }
    // Scan before resuming the connection so edits made outside Obsidian while
    // backgrounded are pending mutations by the time the catch-up pull runs; the
    // pull then treats them as local conflicts instead of overwriting them.
    if (!(await this.reconcileAfterResume())) {
      return;
    }

    const started = await this.syncEngine.startAutoSync();
    if (!started) {
      await this.syncEngine.resumeAutoSyncConnection();
    }
  }

  // Returns false when the mass-delete guard tripped and the resume should stop.
  private async reconcileAfterResume(): Promise<boolean> {
    const now = Date.now();
    if (
      this.lastReconcileAt !== null &&
      now - this.lastReconcileAt < RESUME_RECONCILE_MIN_INTERVAL_MS
    ) {
      return true;
    }

    try {
      const reconcile = await this.syncEngine.reconcileOnce();
      this.lastReconcileAt = now;
      this.recordScan("Resume scan", reconcile);
      if (reconcile.filesQueuedForUpsert > 0 || reconcile.filesQueuedForDelete > 0) {
        this.syncEngine.notifyLocalChange();
      }
    } catch (error) {
      if (error instanceof MassDeleteGuardError) {
        this.handleMassDeleteGuard(error);
        return false;
      }
      this.activityLog.record("error", `Local scan failed: ${describeActivityError(error)}`);
      this.deps.notifyError(error, "Local change scan failed");
    }
    return true;
  }

  registerVaultEvents(): void {
    this.syncEngine.registerVaultEvents();
  }

  async reconcileAfterFileRuleChange(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.syncEngine.hasStore()) {
      return;
    }

    try {
      this.statusTracker.setStatus("syncing");
      await this.syncEngine.reconcileOnce();
      this.syncEngine.notifyLocalChange();
    } catch (error) {
      this.statusTracker.setStatus("attention_needed");
      this.deps.notifyError(error, "Sync file rule update failed");
    }
  }

  async listEntryVersionsForPath(
    path: string,
    before: EntryVersionPageCursor | null,
    limit: number,
  ): Promise<SyncEngineEntryVersionsPage | null> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before viewing version history.");
    }
    return await this.syncEngine.listEntryVersionsForPath(path, before, limit);
  }

  async restoreEntryVersionForPath(path: string, version: EntryVersion): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before restoring version history.");
    }
    await this.syncEngine.restoreEntryVersionForPath(path, version);
  }

  async listDeletedEntries(): Promise<DeletedSyncEntryRow[]> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before viewing deleted files.");
    }
    return await this.syncEngine.listDeletedEntries();
  }

  async restoreDeletedEntry(entryId: string): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before restoring deleted files.");
    }
    await this.syncEngine.restoreDeletedEntry(entryId);
  }

  async downloadAndDecryptVersionBlob(blobId: string): Promise<Uint8Array> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before previewing version history.");
    }
    return await this.syncEngine.downloadAndDecryptVersionBlob(blobId);
  }

  private notify(message: string, timeout?: number): void {
    if (this.deps.notify) {
      this.deps.notify(message, timeout);
      return;
    }

    new Notice(message, timeout);
  }

  private notifySyncConflict(event: {
    entryId?: string;
    op: "upsert" | "delete";
    reason?:
      | "local_pending_mutation"
      | "local_pending_mutation_wins"
      | "remote_path_collision"
      | "remote_path_collision_client_wins";
    originalPath: string;
    conflictPath: string | null;
  }): void {
    this.conflictQueue.enqueue({
      entryId: event.entryId ?? "",
      op: event.op,
      reason: event.reason,
      originalPath: event.originalPath,
      conflictPath: event.conflictPath,
    });

    if (
      (event.reason === "remote_path_collision" ||
        event.reason === "remote_path_collision_client_wins") &&
      event.conflictPath
    ) {
      this.notify(
        `Sync path collision detected. The remote file was saved to "${event.conflictPath}". Open "Sync conflicts" to review.`,
      );
      return;
    }

    if (event.reason === "local_pending_mutation_wins" && event.conflictPath) {
      this.notify(
        `Sync conflict detected. The remote version was saved to "${event.conflictPath}"; your local changes were kept. Open "Sync conflicts" to review.`,
      );
      return;
    }

    if (event.op === "upsert" && event.conflictPath) {
      this.notify(
        `Sync conflict detected. Your local changes were saved to "${event.conflictPath}". Open "Sync conflicts" to review.`,
      );
      return;
    }

    this.notify(
      `Sync conflict detected for "${event.originalPath}". The remote version will be kept. Open "Sync conflicts" to review.`,
    );
  }
}

async function waitAtMost(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
