import type { OsyncSyncProgress, OsyncSyncState } from "../../plugin/view-models";
import type { OsyncSyncFacade } from "../sync-facade";

export function shouldShowSyncSpinner(state: OsyncSyncState): boolean {
  return state === "syncing" || state === "reconnecting";
}

export function formatSyncDescription(
  statusLabel: string,
  syncProgress: OsyncSyncProgress,
  storageStatus: ReturnType<OsyncSyncFacade["getStorageStatus"]>,
): string {
  const parts = [
    `${statusLabel} - ${syncProgress.completedEntries} / ${syncProgress.totalEntries}`,
  ];
  if (storageStatus) {
    const storageLabel =
      storageStatus.storageLimitBytes > 0
        ? `${formatBytes(storageStatus.storageUsedBytes)} / ${formatBytes(storageStatus.storageLimitBytes)}`
        : formatBytes(storageStatus.storageUsedBytes);
    const percent =
      storageStatus.storageLimitBytes > 0
        ? ` (${Math.round((storageStatus.storageUsedBytes / storageStatus.storageLimitBytes) * 100)}%)`
        : "";
    parts.push(`Storage: ${storageLabel}${percent}`);
  }

  return parts.join(" - ");
}

export function formatDeletedFileTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

export function formatDeletedFileGroupLabel(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Groups files by proximity: files deleted within 60 seconds of each other share a group.
export function groupByDeletionTime<T extends { deletedAt: number }>(
  files: T[],
): Array<{ label: string; files: T[] }> {
  if (files.length === 0) return [];

  const sorted = [...files].sort((a, b) => b.deletedAt - a.deletedAt);
  const groups: Array<{ anchor: number; files: T[] }> = [];

  for (const file of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(file.deletedAt - last.anchor) <= 60_000) {
      last.files.push(file);
    } else {
      groups.push({ anchor: file.deletedAt, files: [file] });
    }
  }

  return groups.map((g) => ({
    label: formatDeletedFileGroupLabel(g.anchor),
    files: [...g.files].sort((a, b) => a.deletedAt - b.deletedAt),
  }));
}

function formatBytes(bytes: number): string {
  const safeBytes = Math.max(0, bytes);
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
