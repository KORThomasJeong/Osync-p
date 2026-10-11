import type { SyncCryptoService } from "../core/crypto-service";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncRealtimeSession } from "../remote/realtime-client";
import type {
  SyncEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
} from "../store/ports";
import type { PendingMutationRow } from "../store/store";
import {
  findServerEntryStates,
  isUnreadablePlaceholderPath,
  tryDecryptRemoteMetadata,
} from "./unreadable-entries";

// A commit rejected with stale_revision is normally fixed by the follow-up pull: it
// brings the entry's newer state and rebases the queued change onto it. That pull
// starts at this device's cursor, though, so an entry state the cursor already moved
// past without applying (quarantined while this device held another vault's key) never
// arrives, and the same commit is rejected forever. This resolver reads the entry's
// current state from the server directly and resolves the queued change against it.

export interface StaleEntryTarget {
  mutation: PendingMutationRow;
  // The server's current revision, from the rejection.
  expectedBaseRevision: number | null;
}

export interface StaleEntryResolverStore
  extends Pick<SyncEntryStore, "deleteEntry">,
    Pick<SyncRemoteEntryStore, "applyRemoteState">,
    Pick<SyncMutationStore, "clearDirtyEntryByMutationId" | "getDirtyEntryMutation"> {}

export interface StaleEntryResolverDeps {
  crypto: SyncCryptoService;
  // Applies remote entry states the way a pull would (conflict handling, merges,
  // rebasing the queued change), without moving the cursor.
  applyRemoteEntryStates: (states: RemoteEntryState[]) => Promise<void>;
  // Entries forgotten locally so the local scan uploads their files as new entries.
  onEntriesDetached?: (entryIds: string[]) => void;
  pageSize?: number;
}

export interface StaleEntryResolution {
  // Handed to the pull applier with the entry's current state.
  applied: string[];
  // Forgotten locally; their files upload as new entries on the next scan.
  detached: string[];
  // The queued change had nothing left to do (its delete already happened remotely).
  cleared: string[];
  // Not found on the server, or the queued change moved on meanwhile.
  unresolved: string[];
}

export class StaleEntryResolver {
  constructor(private readonly deps: StaleEntryResolverDeps) {}

  async resolve(
    session: Pick<SyncRealtimeSession, "listEntryStates">,
    store: StaleEntryResolverStore,
    targets: readonly StaleEntryTarget[],
  ): Promise<StaleEntryResolution> {
    const resolution: StaleEntryResolution = {
      applied: [],
      detached: [],
      cleared: [],
      unresolved: [],
    };
    if (targets.length === 0) {
      return resolution;
    }

    // The state we need is at or below our cursor: look it up from cursor 0.
    const states = await findServerEntryStates(
      session,
      new Set(targets.map((target) => target.mutation.entryId)),
      this.deps.pageSize,
    );
    const toApply: RemoteEntryState[] = [];
    for (const target of targets) {
      const { mutation } = target;
      const current = await store.getDirtyEntryMutation(mutation.entryId);
      const state = states.get(mutation.entryId);
      if (!state || current?.mutationId !== mutation.mutationId) {
        resolution.unresolved.push(mutation.entryId);
        continue;
      }

      const metadata = await tryDecryptRemoteMetadata(this.deps.crypto, state);
      const gone =
        state.deleted || !metadata || isUnreadablePlaceholderPath(metadata.path);
      if (!gone) {
        toApply.push(state);
        resolution.applied.push(mutation.entryId);
        continue;
      }

      if (mutation.op === "delete" && state.deleted) {
        // Deleted on the server as well: the queued delete has nothing left to do.
        await store.clearDirtyEntryByMutationId(mutation.mutationId);
        await store.applyRemoteState({
          entryId: mutation.entryId,
          path: metadata && !isUnreadablePlaceholderPath(metadata.path) ? metadata.path : null,
          revision: state.revision,
          blobId: null,
          hash: null,
          deleted: true,
          updatedAt: state.updatedAt,
          entryType: state.entryType,
        });
        resolution.cleared.push(mutation.entryId);
        continue;
      }

      // The server entry is deleted, a removed-unreadable placeholder, or unreadable
      // with this key: there is no readable base to rebase onto. Forget the entry
      // locally (its file stays on disk) so the scan uploads the file as a new entry.
      // A queued delete of an unreadable entry just goes; the file is already gone.
      await store.deleteEntry(mutation.entryId);
      if (mutation.op === "delete") {
        resolution.cleared.push(mutation.entryId);
      } else {
        resolution.detached.push(mutation.entryId);
      }
    }

    if (toApply.length > 0) {
      await this.deps.applyRemoteEntryStates(toApply);
    }
    if (resolution.detached.length > 0) {
      try {
        this.deps.onEntriesDetached?.([...resolution.detached]);
      } catch (error) {
        console.error("[osync] stale resolver: detach listener failed", error);
      }
    }
    console.info(
      `[osync] stale resolver: applied=${resolution.applied.length} detached=${resolution.detached.length} cleared=${resolution.cleared.length} unresolved=${resolution.unresolved.length}`,
    );
    return resolution;
  }
}
