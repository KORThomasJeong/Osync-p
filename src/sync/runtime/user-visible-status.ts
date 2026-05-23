export type UserVisibleSyncState =
  | "not_ready"
  | "syncing"
  | "reconnecting"
  | "up_to_date"
  | "attention_needed";

export interface UserVisibleSyncProgress {
  completedEntries: number;
  totalEntries: number;
}

export function getUserVisibleSyncPercent(
  progress: UserVisibleSyncProgress | null,
): number | null {
  if (!progress || progress.totalEntries <= 0) {
    return null;
  }

  return Math.floor((progress.completedEntries / progress.totalEntries) * 100);
}

export function getUserVisibleSyncDisplayPercent(
  state: UserVisibleSyncState,
  progress: UserVisibleSyncProgress | null = null,
): number {
  const percent = getUserVisibleSyncPercent(progress);
  if (percent !== null) {
    return percent;
  }

  if (state === "up_to_date") {
    return 100;
  }

  return 0;
}

export function formatUserVisibleSyncState(
  state: UserVisibleSyncState,
  progress: UserVisibleSyncProgress | null = null,
): string {
  const percent = getUserVisibleSyncDisplayPercent(state, progress);

  switch (state) {
    case "not_ready":
      return `Sync: not ready ${percent}%`;
    case "syncing":
      return `Sync: syncing ${percent}%`;
    case "reconnecting":
      return `Sync: reconnecting ${percent}%`;
    case "up_to_date":
      return `Sync: up to date ${percent}%`;
    case "attention_needed":
      return `Sync: attention needed ${percent}%`;
  }
}
