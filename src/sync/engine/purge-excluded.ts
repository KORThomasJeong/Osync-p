import { shouldSyncPath, type SyncFileRules } from "../core/file-rules";
import type { RemoteSyncEntryRow } from "../store/store";

// Live remote entries whose path this device's file rules exclude (e.g. an excluded
// folder). These are server-side zombies: the local delete never propagated because the
// event handler ignores excluded paths, so they must be removed by an explicit purge.
export function findExcludedRemoteEntries(
  remoteStates: RemoteSyncEntryRow[],
  rules: SyncFileRules,
): RemoteSyncEntryRow[] {
  return remoteStates.filter(
    (state) =>
      !state.deleted && state.path !== null && !shouldSyncPath(state.path, rules),
  );
}
