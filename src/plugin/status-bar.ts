import type { Plugin } from "obsidian";

export interface OsyncStatusBarState {
  getSyncStatusLabel(): string;
  isSyncPaused(): boolean;
}

export function formatStatusBarSyncLabel(label: string): string {
  return label.replace(/\s+\d+%$/, "");
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
    this.refresh();
  }

  refresh(): void {
    if (!this.statusBar) {
      return;
    }

    const label = formatStatusBarSyncLabel(this.state.getSyncStatusLabel());
    this.statusBar.setText(this.state.isSyncPaused() ? `⏸ ${label}` : label);
  }
}
