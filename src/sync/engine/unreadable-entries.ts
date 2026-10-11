import type { SyncedEntryMetadata } from "../core/content";
import type { SyncCryptoService } from "../core/crypto-service";
import type { ListEntryStatesResponse, RemoteEntryState } from "../remote/changes";
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
const LOOKUP_PAGE_SIZE = 500;
const REMOVAL_BATCH_SIZE = 100;
const RECOVERY_BATCH_SIZE = 100;

type EntryStateSession = Pick<SyncRealtimeSession, "listEntryStates">;

// Pages through every entry state on the server from cursor 0 — including the ones
// this device's cursor already moved past. Shared by the key scan, the recovery of
// quarantined entries and the stale-entry resolver. `visit` returns true to stop.
export async function forEachServerEntryStatePage(
  session: EntryStateSession,
  pageSize: number,
  visit: (page: ListEntryStatesResponse) => Promise<boolean | void> | boolean | void,
): Promise<void> {
  let after: { updatedSeq: number; entryId: string } | null = null;
  let targetCursor: number | null = null;
  let hasMore = true;
  while (hasMore) {
    const page = await session.listEntryStates({
      sinceCursor: 0,
      targetCursor,
      after,
      limit: pageSize,
    });
    targetCursor = page.targetCursor;
    if ((await visit(page)) === true) {
      return;
    }
    hasMore = page.hasMore;
    after = page.nextAfter;
  }
}

// The current server state of each requested entry (absent when not on the server).
// Stops paging as soon as every requested entry was found.
export async function findServerEntryStates(
  session: EntryStateSession,
  entryIds: ReadonlySet<string>,
  pageSize = LOOKUP_PAGE_SIZE,
): Promise<Map<string, RemoteEntryState>> {
  const found = new Map<string, RemoteEntryState>();
  if (entryIds.size === 0) {
    return found;
  }
  await forEachServerEntryStatePage(session, pageSize, (page) => {
    for (const state of page.entries) {
      if (entryIds.has(state.entryId)) {
        found.set(state.entryId, state);
      }
    }
    return found.size >= entryIds.size;
  });
  return found;
}

export async function tryDecryptRemoteMetadata(
  crypto: SyncCryptoService,
  state: RemoteEntryState,
): Promise<SyncedEntryMetadata | null> {
  try {
    return await crypto.decryptMetadata(
      state.encryptedMetadata,
      metadataContextFromRemoteState(state),
    );
  } catch {
    return null;
  }
}

// Read-only: pages through every entry state on the server (from cursor 0) and tries
// to decrypt its metadata. No blobs are downloaded and nothing is written.
// `onReadable` receives every state (deleted ones included) whose metadata decrypted.
export async function scanUnreadableRemoteEntries(input: {
  session: EntryStateSession;
  crypto: SyncCryptoService;
  onProgress?: (scanned: number, total: number) => void;
  onReadable?: (state: RemoteEntryState) => void;
  pageSize?: number;
}): Promise<UnreadableScanResult> {
  const unreadable: UnreadableRemoteEntry[] = [];
  let scanned = 0;

  await forEachServerEntryStatePage(input.session, input.pageSize ?? SCAN_PAGE_SIZE, async (page) => {
    for (const state of page.entries) {
      scanned += 1;
      // A deleted entry needs no removal, whatever key wrote it.
      if (state.deleted && !input.onReadable) {
        continue;
      }
      if (await tryDecryptRemoteMetadata(input.crypto, state)) {
        input.onReadable?.(state);
      } else if (!state.deleted) {
        unreadable.push({
          entryId: state.entryId,
          revision: state.revision,
          entryType: state.entryType ?? "file",
        });
      }
    }
    input.onProgress?.(scanned, Math.max(scanned, page.totalEntries));
  });

  return { scannedEntries: scanned, unreadable };
}

export interface UnreadableRecoveryResult {
  // Decrypted now and handed to the pull applier. An entry whose content still
  // fails to decrypt there is quarantined again by the applier.
  applied: string[];
  // Still not decryptable with this key: left alone (never written, never deleted).
  stillUnreadable: string[];
  // No longer on the server: nothing left to fetch.
  notFound: string[];
  // Applying their batch failed (e.g. a download error): candidates for the next try.
  failed: string[];
}

// Applies remote states in bounded batches; a failing batch is reported, not thrown,
// so one bad entry never stops the others.
export async function applyRecoveredEntryStates(
  states: readonly RemoteEntryState[],
  applyRemoteEntryStates: (states: RemoteEntryState[]) => Promise<void>,
  batchSize = RECOVERY_BATCH_SIZE,
): Promise<{ applied: string[]; failed: string[] }> {
  const size = Math.max(1, batchSize);
  const result: { applied: string[]; failed: string[] } = { applied: [], failed: [] };
  for (let offset = 0; offset < states.length; offset += size) {
    const batch = states.slice(offset, offset + size);
    const ids = batch.map((state) => state.entryId);
    try {
      await applyRemoteEntryStates(batch);
      result.applied.push(...ids);
    } catch (error) {
      console.error(
        `[osync] unreadable recovery: applying ${ids.length} recovered entr${ids.length === 1 ? "y" : "ies"} failed`,
        error,
      );
      result.failed.push(...ids);
    }
  }
  return result;
}

// Re-fetches the current server state of entries a pull quarantined (their metadata or
// content did not decrypt with the key this device held then) and applies the ones
// that decrypt now through the normal pull path — conflicts, adoption of identical
// local files and rebasing of queued changes included — without moving the cursor.
export async function recoverUnreadableEntries(input: {
  session: EntryStateSession;
  crypto: SyncCryptoService;
  entryIds: readonly string[];
  applyRemoteEntryStates: (states: RemoteEntryState[]) => Promise<void>;
  batchSize?: number;
  pageSize?: number;
}): Promise<UnreadableRecoveryResult> {
  const result: UnreadableRecoveryResult = {
    applied: [],
    stillUnreadable: [],
    notFound: [],
    failed: [],
  };
  const ids = [...new Set(input.entryIds)];
  if (ids.length === 0) {
    return result;
  }

  const states = await findServerEntryStates(input.session, new Set(ids), input.pageSize);
  const readable: RemoteEntryState[] = [];
  for (const entryId of ids) {
    const state = states.get(entryId);
    if (!state) {
      result.notFound.push(entryId);
    } else if (await tryDecryptRemoteMetadata(input.crypto, state)) {
      readable.push(state);
    } else {
      result.stillUnreadable.push(entryId);
    }
  }

  const applied = await applyRecoveredEntryStates(
    readable,
    input.applyRemoteEntryStates,
    input.batchSize,
  );
  result.applied = applied.applied;
  result.failed = applied.failed;
  return result;
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
