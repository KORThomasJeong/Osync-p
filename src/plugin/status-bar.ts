import type { Plugin } from "obsidian";

import { formatLastVerifiedLabel } from "../sync/runtime/user-visible-status";

export interface OsyncStatusBarState {
  getSyncStatusLabel(): string;
  isSyncPaused(): boolean;
  getLastVerifiedAt?(): number | null;
}

export function formatStatusBarSyncLabel(label: string): string {
  return label.replace(/\s+\d+%$/, "");
}

export function formatStatusBarTooltip(
  label: string,
  lastVerifiedAt: number | null | undefined,
  now: number = Date.now(),
): string {
  if (lastVerifiedAt === undefined) {
    return label;
  }

  return `${label}\n${formatLastVerifiedLabel(lastVerifiedAt, now)}`;
}

export class OsyncStatusBar {
  private statusBar: HTMLElement | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly state: OsyncStatusBarState,
    private readonly onTogglePause?: () => void,
  ) {}

  initialize(): void {
    this.statusBar = this.plugin.addStatusBarItem();
    if (this.onTogglePause) {
      this.statusBar.addClass("osync-clickable");
      this.statusBar.addEventListener("click", () => {
        this.onTogglePause?.();
      });
    }
    // The status bar sits at the window bottom, so open the tooltip upwards.
    this.statusBar.setAttr("data-tooltip-position", "top");
    // "N min ago" goes stale between refreshes; recompute it when the tooltip shows.
    this.statusBar.addEventListener("mouseenter", () => {
      this.refreshTooltip();
    });
    this.refresh();
  }

  refresh(): void {
    if (!this.statusBar) {
      return;
    }

    const label = formatStatusBarSyncLabel(this.state.getSyncStatusLabel());
    this.statusBar.setText(this.state.isSyncPaused() ? `⏸ ${label}` : label);
    this.refreshTooltip();
  }

  private refreshTooltip(): void {
    if (!this.statusBar) {
      return;
    }

    this.statusBar.setAttr(
      "aria-label",
      formatStatusBarTooltip(
        this.state.getSyncStatusLabel(),
        this.state.getLastVerifiedAt?.(),
      ),
    );
  }
}
