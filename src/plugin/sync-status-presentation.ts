import { getIcon } from "obsidian";

import {
  formatLastVerifiedLabel,
  type UserVisibleSyncState,
} from "../sync/runtime/user-visible-status";

export interface OsyncSyncStateIcon {
  icon: string;
  // Used when the preferred icon is not bundled with the running Obsidian build.
  fallback: string | null;
}

export function getSyncStateIcon(state: UserVisibleSyncState): OsyncSyncStateIcon {
  switch (state) {
    case "up_to_date":
      return { icon: "cloud-check", fallback: "check-circle" };
    case "syncing":
    case "checking":
      return { icon: "refresh-cw", fallback: null };
    case "attention_needed":
      return { icon: "alert-triangle", fallback: null };
    case "reconnecting":
    case "not_ready":
      return { icon: "cloud-off", fallback: null };
  }
}

export function resolveSyncStateIconId(
  state: UserVisibleSyncState,
  hasIcon: (iconId: string) => boolean = hasObsidianIcon,
): string {
  const { icon, fallback } = getSyncStateIcon(state);
  if (fallback !== null && !hasIcon(icon)) {
    return fallback;
  }
  return icon;
}

function hasObsidianIcon(iconId: string): boolean {
  try {
    return getIcon(iconId) !== null;
  } catch {
    return false;
  }
}

export function formatSyncStateHeadline(
  state: UserVisibleSyncState,
  statusLabel = "",
): string {
  switch (state) {
    case "not_ready":
      return "Not ready";
    case "syncing": {
      const percent = /(\d+)%\s*$/.exec(statusLabel)?.[1];
      return percent ? `Syncing… ${percent}%` : "Syncing…";
    }
    case "reconnecting":
      return "Reconnecting…";
    case "checking":
      return "Checking…";
    case "up_to_date":
      return "Up to date";
    case "attention_needed":
      return "Attention needed";
  }
}

export function formatLastServerCheck(
  lastVerifiedAt: number | null,
  now: number = Date.now(),
): string {
  if (lastVerifiedAt === null) {
    return "Last server check: never";
  }
  return formatLastVerifiedLabel(lastVerifiedAt, now);
}

export function formatSyncStatusTooltip(
  statusLabel: string,
  lastVerifiedAt: number | null,
  now: number = Date.now(),
): string {
  return `${statusLabel}\n${formatLastServerCheck(lastVerifiedAt, now)}`;
}

export function formatStatusBytes(bytes: number): string {
  const safeBytes = Math.max(0, Number(bytes) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = safeBytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${safeBytes} B`;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-US")} ${units[unitIndex]}`;
}

export function formatPendingAndStorage(
  pendingUploads: number | null,
  storage: { storageUsedBytes: number; storageLimitBytes: number } | null,
): string {
  const pending = pendingUploads === null ? "…" : String(pendingUploads);
  const storageText = storage
    ? `${formatStatusBytes(storage.storageUsedBytes)} / ${formatStatusBytes(storage.storageLimitBytes)}`
    : "—";
  return `Pending uploads: ${pending} · Storage: ${storageText}`;
}

export interface OsyncActivityLogEntry {
  at: number;
  kind: string;
  message: string;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function formatActivityTime(at: number): string {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Newest first, for on-screen display.
export function sortActivityNewestFirst(
  entries: readonly OsyncActivityLogEntry[],
): OsyncActivityLogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => right.entry.at - left.entry.at || right.index - left.index)
    .map(({ entry }) => entry);
}

// Oldest first with ISO timestamps, for pasting into a bug report.
export function formatActivityLogForCopy(entries: readonly OsyncActivityLogEntry[]): string {
  return sortActivityNewestFirst(entries)
    .reverse()
    .map((entry) => `${new Date(entry.at).toISOString()} ${entry.kind} ${entry.message}`)
    .join("\n");
}
