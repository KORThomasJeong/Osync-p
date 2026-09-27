export type UserVisibleSyncState =
  | "not_ready"
  | "syncing"
  | "reconnecting"
  // Re-verifying against the server after a resume; "up to date" is not yet known.
  | "checking"
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
    case "checking":
      return `Sync: checking ${percent}%`;
    case "up_to_date":
      return `Sync: up to date ${percent}%`;
    case "attention_needed":
      return `Sync: attention needed ${percent}%`;
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatLastVerifiedLabel(
  lastVerifiedAt: number | null,
  now: number = Date.now(),
): string {
  if (lastVerifiedAt === null) {
    return "Last server check: not yet";
  }

  const ageMs = Math.max(0, now - lastVerifiedAt);
  if (ageMs < MINUTE_MS) {
    return "Last server check: just now";
  }
  if (ageMs < HOUR_MS) {
    return `Last server check: ${Math.floor(ageMs / MINUTE_MS)} min ago`;
  }
  if (ageMs < DAY_MS) {
    return `Last server check: ${Math.floor(ageMs / HOUR_MS)} h ago`;
  }
  return `Last server check: ${Math.floor(ageMs / DAY_MS)} d ago`;
}
