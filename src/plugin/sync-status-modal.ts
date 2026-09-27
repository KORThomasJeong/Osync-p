import { type App, Modal, Notice, setIcon } from "obsidian";

import type { UserVisibleSyncState } from "../sync/runtime/user-visible-status";
import {
  formatActivityLogForCopy,
  formatActivityTime,
  formatLastServerCheck,
  formatPendingAndStorage,
  formatSyncStateHeadline,
  resolveSyncStateIconId,
  sortActivityNewestFirst,
  type OsyncActivityLogEntry,
} from "./sync-status-presentation";

export interface OsyncSyncStatusSource {
  getSyncState(): UserVisibleSyncState;
  getSyncStatusLabel(): string;
  getLastVerifiedAt(): number | null;
  getStorageStatus(): { storageUsedBytes: number; storageLimitBytes: number } | null;
  getPendingUploadCount(): Promise<number>;
  getConflictCount(): number;
  openConflicts(): void;
  checkNow(): Promise<void>;
  getActivityLog(): readonly OsyncActivityLogEntry[];
  onActivityLogChange(listener: () => void): () => void;
  clearActivityLog(): void;
  onStatusChange(listener: () => void): () => void;
  // Optional: keeps storage usage fresh while the modal is open.
  watchStorageStatus?(): void;
  unwatchStorageStatus?(): void;
}

export interface OsyncSyncStatusModalOptions {
  now?: () => number;
  writeClipboard?: (text: string) => Promise<void>;
  lastCheckRefreshMs?: number;
}

const LAST_CHECK_REFRESH_MS = 15_000;

async function writeToSystemClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    throw new Error("Clipboard is not available.");
  }
  await navigator.clipboard.writeText(text);
}

export class OsyncSyncStatusModal extends Modal {
  private readonly now: () => number;
  private readonly writeClipboard: (text: string) => Promise<void>;
  private readonly lastCheckRefreshMs: number;
  private cleanups: Array<() => void> = [];
  private isOpen = false;
  private checkRunning = false;
  private pendingUploads: number | null = null;
  private pendingRequestInFlight = false;
  private pendingRequestQueued = false;

  private headerIconEl: HTMLElement | null = null;
  private headerTextEl: HTMLElement | null = null;
  private lastCheckEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private checkButtonEl: HTMLButtonElement | null = null;
  private checkButtonIconEl: HTMLElement | null = null;
  private checkButtonTextEl: HTMLElement | null = null;
  private conflictsButtonEl: HTMLButtonElement | null = null;
  private activitySummaryEl: HTMLElement | null = null;
  private activityListEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly source: OsyncSyncStatusSource,
    options: OsyncSyncStatusModalOptions = {},
  ) {
    super(app);
    this.now = options.now ?? (() => Date.now());
    this.writeClipboard = options.writeClipboard ?? writeToSystemClipboard;
    this.lastCheckRefreshMs = options.lastCheckRefreshMs ?? LAST_CHECK_REFRESH_MS;
  }

  onOpen(): void {
    this.isOpen = true;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("osync-status-modal");

    const header = contentEl.createDiv({ cls: "osync-status-header" });
    this.headerIconEl = header.createSpan({ cls: "osync-status-header-icon" });
    this.headerTextEl = header.createEl("h2", { cls: "osync-status-header-text" });

    this.lastCheckEl = contentEl.createDiv({ cls: "osync-status-line osync-status-last-check" });
    this.summaryEl = contentEl.createDiv({ cls: "osync-status-line osync-status-summary" });

    const actions = contentEl.createDiv({ cls: "osync-status-actions" });
    this.checkButtonEl = actions.createEl("button", { cls: "mod-cta osync-status-check" });
    this.checkButtonIconEl = this.checkButtonEl.createSpan({ cls: "osync-status-button-icon" });
    this.checkButtonTextEl = this.checkButtonEl.createSpan({ text: "Check now" });
    this.checkButtonEl.addEventListener("click", () => {
      void this.runCheckNow();
    });

    this.conflictsButtonEl = actions.createEl("button", { cls: "osync-status-conflicts" });
    this.conflictsButtonEl.addEventListener("click", () => {
      this.close();
      this.source.openConflicts();
    });

    const activity = contentEl.createEl("details", { cls: "osync-status-activity" });
    this.activitySummaryEl = activity.createEl("summary", { cls: "osync-status-activity-summary" });
    const activityActions = activity.createDiv({ cls: "osync-status-activity-actions" });
    const copyButton = activityActions.createEl("button", { text: "Copy" });
    copyButton.addEventListener("click", () => {
      void this.copyActivityLog();
    });
    const clearButton = activityActions.createEl("button", { text: "Clear" });
    clearButton.addEventListener("click", () => {
      this.source.clearActivityLog();
      this.renderActivity();
    });
    this.activityListEl = activity.createDiv({ cls: "osync-status-activity-list" });

    this.cleanups.push(
      this.source.onStatusChange(() => {
        this.renderStatus();
        this.requestPendingUploadCount();
      }),
    );
    this.cleanups.push(
      this.source.onActivityLogChange(() => {
        this.renderActivity();
      }),
    );
    const timer = setInterval(() => {
      this.renderLastCheck();
    }, this.lastCheckRefreshMs);
    this.cleanups.push(() => {
      clearInterval(timer);
    });
    if (this.source.watchStorageStatus) {
      this.source.watchStorageStatus();
      this.cleanups.push(() => {
        this.source.unwatchStorageStatus?.();
      });
    }

    this.renderStatus();
    this.renderActivity();
    this.requestPendingUploadCount();
  }

  onClose(): void {
    this.isOpen = false;
    const cleanups = this.cleanups;
    this.cleanups = [];
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        console.warn("[osync:status-modal] cleanup failed", error);
      }
    }
    this.contentEl.empty();
  }

  private renderStatus(): void {
    if (!this.isOpen) return;
    const state = this.source.getSyncState();
    if (this.headerIconEl) {
      setIcon(this.headerIconEl, resolveSyncStateIconId(state));
    }
    this.headerIconEl?.setAttr("data-state", state);
    this.headerTextEl?.setText(
      formatSyncStateHeadline(state, this.source.getSyncStatusLabel()),
    );
    this.renderLastCheck();
    this.renderSummary();
    this.renderButtons();
  }

  private renderLastCheck(): void {
    if (!this.isOpen) return;
    this.lastCheckEl?.setText(
      formatLastServerCheck(this.source.getLastVerifiedAt(), this.now()),
    );
  }

  private renderSummary(): void {
    if (!this.isOpen) return;
    this.summaryEl?.setText(
      formatPendingAndStorage(this.pendingUploads, this.source.getStorageStatus()),
    );
  }

  private renderButtons(): void {
    if (this.checkButtonEl && this.checkButtonIconEl && this.checkButtonTextEl) {
      this.checkButtonEl.disabled = this.checkRunning;
      this.checkButtonEl.toggleClass("is-loading", this.checkRunning);
      this.checkButtonIconEl.toggleClass("osync-status-spin", this.checkRunning);
      setIcon(this.checkButtonIconEl, "refresh-cw");
      this.checkButtonTextEl.setText(this.checkRunning ? "Checking…" : "Check now");
    }
    this.conflictsButtonEl?.setText(`Sync conflicts (${this.source.getConflictCount()})`);
  }

  private renderActivity(): void {
    if (!this.isOpen || !this.activityListEl) return;
    const entries = sortActivityNewestFirst(this.source.getActivityLog());
    this.activitySummaryEl?.setText(`Recent activity (${entries.length})`);
    this.activityListEl.empty();
    if (entries.length === 0) {
      this.activityListEl.createDiv({
        cls: "osync-status-activity-empty",
        text: "No recent activity.",
      });
      return;
    }
    for (const entry of entries) {
      const row = this.activityListEl.createDiv({ cls: "osync-status-activity-row" });
      row.createSpan({ cls: "osync-status-activity-time", text: formatActivityTime(entry.at) });
      row.createSpan({ cls: "osync-status-activity-kind", text: entry.kind });
      row.createSpan({ cls: "osync-status-activity-message", text: entry.message });
    }
  }

  private async runCheckNow(): Promise<void> {
    if (this.checkRunning) return;
    this.checkRunning = true;
    this.renderButtons();
    try {
      await this.source.checkNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Osync: Check failed: ${message}`);
    } finally {
      this.checkRunning = false;
      if (this.isOpen) {
        this.renderStatus();
        this.requestPendingUploadCount();
      }
    }
  }

  private async copyActivityLog(): Promise<void> {
    const text = formatActivityLogForCopy(this.source.getActivityLog());
    try {
      await this.writeClipboard(text);
      new Notice("Osync: Activity log copied.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Osync: Could not copy activity log: ${message}`);
    }
  }

  // Coalesces bursts of status changes into at most one in-flight count query.
  private requestPendingUploadCount(): void {
    if (!this.isOpen) return;
    if (this.pendingRequestInFlight) {
      this.pendingRequestQueued = true;
      return;
    }
    this.pendingRequestInFlight = true;
    void this.source
      .getPendingUploadCount()
      .then((count) => {
        this.pendingUploads = count;
      })
      .catch((error: unknown) => {
        console.warn("[osync:status-modal] pending upload count failed", error);
      })
      .finally(() => {
        this.pendingRequestInFlight = false;
        this.renderSummary();
        if (this.pendingRequestQueued) {
          this.pendingRequestQueued = false;
          this.requestPendingUploadCount();
        }
      });
  }
}
