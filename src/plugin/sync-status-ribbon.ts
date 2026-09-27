import { type Plugin, setIcon } from "obsidian";

import type { OsyncSyncStatusSource } from "./sync-status-modal";
import { formatSyncStatusTooltip, resolveSyncStateIconId } from "./sync-status-presentation";

export type OsyncSyncStatusRibbonState = Pick<
  OsyncSyncStatusSource,
  "getSyncState" | "getSyncStatusLabel" | "getLastVerifiedAt"
>;

// Mobile Obsidian has no status bar; the ribbon icon is the always-visible
// sync indicator there (and a shortcut to the status modal on desktop).
export class OsyncSyncStatusRibbon {
  private ribbonEl: HTMLElement | null = null;
  private currentIcon: string | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly state: OsyncSyncStatusRibbonState,
    private readonly onOpen: () => void,
  ) {}

  initialize(): void {
    const icon = resolveSyncStateIconId(this.state.getSyncState());
    this.ribbonEl = this.plugin.addRibbonIcon(icon, "Osync: sync status", () => {
      this.onOpen();
    });
    this.currentIcon = icon;
    this.ribbonEl.addClass("osync-status-ribbon");
    // "N min ago" goes stale between refreshes; recompute it when the tooltip shows.
    this.ribbonEl.addEventListener("mouseenter", () => {
      this.refreshTooltip();
    });
    this.refresh();
  }

  refresh(): void {
    if (!this.ribbonEl) return;
    const state = this.state.getSyncState();
    const icon = resolveSyncStateIconId(state);
    if (icon !== this.currentIcon) {
      setIcon(this.ribbonEl, icon);
      this.currentIcon = icon;
    }
    this.ribbonEl.setAttr("data-osync-state", state);
    this.refreshTooltip();
  }

  private refreshTooltip(): void {
    if (!this.ribbonEl) return;
    this.ribbonEl.setAttr(
      "aria-label",
      formatSyncStatusTooltip(this.state.getSyncStatusLabel(), this.state.getLastVerifiedAt()),
    );
  }
}
