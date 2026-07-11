import { Notice, type Plugin } from "obsidian";

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
import type {
  UserVisibleSyncProgress,
  UserVisibleSyncState,
} from "./user-visible-status";

export type { InitialCollisionPreview } from "./engine";

export type {
  ConflictQueueItem,
  ConflictQueueSource,
} from "./conflict-queue";

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
}

export class SyncController {
  private readonly statusTracker = new UserVisibleSyncStatusTracker(() =>
    this.deps.onStatusChange?.(),
  );
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
  });
  private readonly conflictQueue = new SyncConflictQueue();

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
    this.syncEngine.stopAutoSync();
    await this.syncEngine.closeStore();
  }

  async readLocalVaultId(): Promise<string> {
    return await this.syncEngine.readLocalVaultId();
  }

  async getOrCreateLocalVaultId(remoteVaultId: string): Promise<string> {
    return await this.syncEngine.getOrCreateLocalVaultId(remoteVaultId);
  }

  stopAutoSyncAndMarkNotReady(): void {
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
    this.syncEngine.pauseAutoSync();
  }

  resumeAutoSyncFromPause(): void {
    this.syncEngine.resumeAutoSyncFromPause();
  }

  async resetLocalSyncState(opts?: { preserveLocalVaultId?: boolean }): Promise<void> {
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
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
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
      await this.syncEngine.waitForLocalMutationWork();
      await this.syncEngine.startAutoSync();
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
        this.handleMassDeleteGuard(error);
        return;
      }
      const classification = classifyReconnectError(error);
      if (classification.kind === "transient") {
        // Likely offline at startup; connectivity events will retry quietly.
        this.statusTracker.setStatus("reconnecting");
        return;
      }
      this.statusTracker.setStatus("attention_needed");
      this.deps.notifyError(error, "Auto sync initialization failed");
    }
  }

  private handleMassDeleteGuard(error: MassDeleteGuardError): void {
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

    if (!this.syncEngine.hasStore()) {
      await this.ensureAutoSyncState();
      return;
    }

    const started = await this.syncEngine.startAutoSync();
    if (!started) {
      await this.syncEngine.resumeAutoSyncConnection();
    }
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
