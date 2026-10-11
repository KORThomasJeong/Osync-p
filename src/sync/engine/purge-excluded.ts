import { matchesSyncFileRules, type SyncFileRules } from "../core/file-rules";
import type { RemoteSyncEntryRow } from "../store/store";

// Live remote entries whose path this device's file rules exclude (e.g. an excluded
// folder). Only the user-configured rules count: a path this particular device cannot
// hold (too long, a Windows-invalid name) is still a live file for the other devices and
// must never be purged from the server. These are server-side zombies: the local delete never propagated because the
// event handler ignores excluded paths, so they must be removed by an explicit purge.
export function findExcludedRemoteEntries(
  remoteStates: RemoteSyncEntryRow[],
  rules: SyncFileRules,
): RemoteSyncEntryRow[] {
  return remoteStates.filter(
    (state) =>
      !state.deleted && state.path !== null && !matchesSyncFileRules(state.path, rules),
  );
}
