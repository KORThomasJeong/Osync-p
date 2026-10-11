import type { SyncCryptoService } from "../core/crypto-service";
import type { CommitMutationPayload, SyncRealtimeSession } from "../remote/realtime-client";
import type { SyncEntryStore } from "../store/ports";
import { metadataContextFromRemoteState } from "./pull-entry-state-internal";

// Entries on the server that this device's vault key cannot decrypt — typically
// written by a device that held another vault's key. They can never be applied here,
// and no device with the correct key can read them either.
//
// Removing one from the server commits a delete whose (correctly encrypted) metadata
// carries a placeholder path instead of a real one, since the real path is unknown.
// Every device must treat a placeholder entry as "never on disk": it is not written,
// it never removes a file, and an entry a device still maps to a real local file is
// forgotten so the file is uploaded again as a new entry (see the pull applier).

export const UNREADABLE_PLACEHOLDER_DIR = ".osync-unreadable";

export function unreadablePlaceholderPath(entryId: string): string {
  return `${UNREADABLE_PLACEHOLDER_DIR}/${entryId}`;
}

export function isUnreadablePlaceholderPath(path: string | null | undefined): boolean {
  return (
    !!path &&
    (path === UNREADABLE_PLACEHOLDER_DIR || path.startsWith(`${UNREADABLE_PLACEHOLDER_DIR}/`))
  );
}

export interface UnreadableRemoteEntry {
  entryId: string;
  // The server's current revision: a removal commits at exactly this base.
  revision: number;
  entryType: "file" | "folder";
}

export interface UnreadableScanResult {
  scannedEntries: number;
  unreadable: UnreadableRemoteEntry[];
}

const SCAN_PAGE_SIZE = 250;
const REMOVAL_BATCH_SIZE = 100;

// Read-only: pages through every entry state on the server (from cursor 0) and tries
// to decrypt its metadata. No blobs are downloaded and nothing is written.
export async function scanUnreadableRemoteEntries(input: {
  session: Pick<SyncRealtimeSession, "listEntryStates">;
  crypto: SyncCryptoService;
  onProgress?: (scanned: number, total: number) => void;
  pageSize?: number;
}): Promise<UnreadableScanResult> {
  const unreadable: UnreadableRemoteEntry[] = [];
  let scanned = 0;
  let after: { updatedSeq: number; entryId: string } | null = null;
  let targetCursor: number | null = null;
  let hasMore = true;

  while (hasMore) {
    const page = await input.session.listEntryStates({
      sinceCursor: 0,
      targetCursor,
      after,
      limit: input.pageSize ?? SCAN_PAGE_SIZE,
    });
    targetCursor = page.targetCursor;
    for (const state of page.entries) {
      scanned += 1;
      // A deleted entry needs no removal, whatever key wrote it.
      if (state.deleted) {
        continue;
      }
      try {
        await input.crypto.decryptMetadata(
          state.encryptedMetadata,
          metadataContextFromRemoteState(state),
        );
      } catch {
        unreadable.push({
          entryId: state.entryId,
          revision: state.revision,
          entryType: state.entryType ?? "file",
        });
      }
    }
    input.onProgress?.(scanned, Math.max(scanned, page.totalEntries));
    hasMore = page.hasMore;
    after = page.nextAfter;
  }

  return { scannedEntries: scanned, unreadable };
}

export interface UnreadableRemovalResult {
  removed: string[];
  // Typically stale_revision: the entry changed since the scan. Scan again.
  failed: Array<{ entryId: string; code: string }>;
}

// Commits a delete for each target directly on the server (not through the local
// pending-mutation queue, so no local entry or file is involved). Callers must only
// run this after confirming this device's key matches the vault's fingerprint.
export async function commitUnreadableRemovals(input: {
  session: Pick<SyncRealtimeSession, "commitMutations">;
  crypto: SyncCryptoService;
  targets: readonly UnreadableRemoteEntry[];
  now?: () => number;
  batchSize?: number;
}): Promise<UnreadableRemovalResult> {
  const now = input.now ?? (() => Date.now());
  const batchSize = Math.max(1, input.batchSize ?? REMOVAL_BATCH_SIZE);
  const result: UnreadableRemovalResult = { removed: [], failed: [] };

  for (let offset = 0; offset < input.targets.length; offset += batchSize) {
    const batch = input.targets.slice(offset, offset + batchSize);
    const mutations: CommitMutationPayload[] = [];
    for (const target of batch) {
      mutations.push({
        mutationId: crypto.randomUUID(),
        entryId: target.entryId,
        op: "delete",
        entryType: target.entryType,
        baseRevision: target.revision,
        blobId: null,
        encryptedMetadata: await input.crypto.encryptMetadata(
          { path: unreadablePlaceholderPath(target.entryId), hash: null, editedAt: now() },
          {
            entryId: target.entryId,
            revision: target.revision + 1,
            op: "delete",
            blobId: null,
          },
        ),
        pathToken: null,
      });
    }
    const committed = await input.session.commitMutations(mutations);
    for (const outcome of committed.results) {
      if (outcome.status === "accepted") {
        result.removed.push(outcome.entryId);
      } else {
        result.failed.push({ entryId: outcome.entryId, code: outcome.code });
      }
    }
  }

  return result;
}

// Forgets local entries (state + any queued mutation) without touching their files.
// A file whose entry is forgotten is no longer known to sync, so the next local scan
// uploads it as a new entry. Returns the entryIds that were known here.
export async function detachLocalEntries(
  store: Pick<SyncEntryStore, "getEntryStateById" | "deleteEntry">,
  entryIds: readonly string[],
): Promise<string[]> {
  const detached: string[] = [];
  for (const entryId of entryIds) {
    if (!(await store.getEntryStateById(entryId))) {
      continue;
    }
    await store.deleteEntry(entryId);
    detached.push(entryId);
  }
  return detached;
}
