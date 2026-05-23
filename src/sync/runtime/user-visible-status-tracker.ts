import type { SyncStorageStatus } from "../remote/realtime-client";
import {
  formatUserVisibleSyncState,
  getUserVisibleSyncDisplayPercent,
  type UserVisibleSyncProgress,
  type UserVisibleSyncState,
} from "./user-visible-status";

/**
 * Owns the user-visible sync state (status, progress, storage) and notifies
 * via `onChange` whenever any of those values actually change. Both the
 * `SyncController` and `SyncEngine` push state into this tracker; the
 * controller exposes read-only getters that delegate here.
 *
 * Centralising this state removes the engine -> controller -> engine
 * circular callback shape that the controller previously hosted itself.
 */
export class UserVisibleSyncStatusTracker {
  private status: UserVisibleSyncState = "not_ready";
  private progress: UserVisibleSyncProgress = {
    completedEntries: 0,
    totalEntries: 0,
  };
  private storageStatus: SyncStorageStatus | null = null;

  constructor(private readonly onChange: () => void) {}

  setStatus(status: UserVisibleSyncState): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.onChange();
  }

  setProgress(progress: UserVisibleSyncProgress | null): void {
    if (!progress) {
      return;
    }

    const normalized =
      progress.totalEntries > 0
        ? {
            completedEntries: Math.max(0, progress.completedEntries),
            totalEntries: Math.max(0, progress.totalEntries),
          }
        : {
            completedEntries: 0,
            totalEntries: 0,
          };

    if (
      this.progress?.completedEntries === normalized?.completedEntries &&
      this.progress?.totalEntries === normalized?.totalEntries
    ) {
      return;
    }

    this.progress = normalized;
    this.onChange();
  }

  setStorageStatus(status: SyncStorageStatus | null): void {
    if (
      this.storageStatus?.storageUsedBytes === status?.storageUsedBytes &&
      this.storageStatus?.storageLimitBytes === status?.storageLimitBytes
    ) {
      return;
    }

    this.storageStatus = status;
    this.onChange();
  }

  getStatusLabel(): string {
    return formatUserVisibleSyncState(this.status, this.progress);
  }

  getState(): UserVisibleSyncState {
    return this.status;
  }

  getDisplayPercent(): number {
    return getUserVisibleSyncDisplayPercent(this.status, this.progress);
  }

  getProgress(): UserVisibleSyncProgress {
    return this.progress;
  }

  getStorageStatus(): SyncStorageStatus | null {
    return this.storageStatus;
  }
}
