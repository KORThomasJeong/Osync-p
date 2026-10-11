import type { SyncedEntryMetadata } from "../core/content";
import type { SyncCryptoService } from "../core/crypto-service";
import type {
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
} from "../store/ports";
import type { PendingMutationRow } from "../store/store";

// A queued local change whose metadata this device's current key cannot decrypt —
// typically recorded while the device held another vault's key. It can never be
// committed (the server would store metadata no device can read) and retrying it
// fails forever, so it is dropped: the queued row goes, the remote state stays, and
// the local state falls back to the remote one. The next full local scan then sees
// the file on disk differ from what is known and queues it again with the current
// key. Local files are never touched.

export interface UndecryptablePendingStore
  extends Pick<SyncEntryStore, "deleteEntry">,
    Pick<SyncRemoteEntryStore, "getRemoteStateById">,
    Pick<SyncLocalEntryStore, "applyLocalState" | "clearLocalState">,
    Pick<SyncMutationStore, "clearDirtyEntryByMutationId"> {}

export function pendingMetadataContext(mutation: PendingMutationRow) {
  return {
    entryId: mutation.entryId,
    revision: mutation.baseRevision + 1,
    op: mutation.op,
    blobId: mutation.blobId,
  };
}

// The pending row's metadata, or null when this device's key cannot decrypt it.
export async function tryDecryptPendingMetadata(
  crypto: SyncCryptoService,
  mutation: PendingMutationRow,
): Promise<SyncedEntryMetadata | null> {
  try {
    return await crypto.decryptMetadata(
      mutation.encryptedMetadata,
      pendingMetadataContext(mutation),
    );
  } catch (error) {
    console.warn(
      `[osync] pending mutation ${mutation.mutationId} entry=${mutation.entryId} op=${mutation.op} rev=${mutation.baseRevision + 1} can't be decrypted with this vault's key`,
      error,
    );
    return null;
  }
}

export async function dropUndecryptablePendingMutation(
  store: UndecryptablePendingStore,
  mutation: PendingMutationRow,
): Promise<void> {
  await store.clearDirtyEntryByMutationId(mutation.mutationId);
  const remote = await store.getRemoteStateById(mutation.entryId);
  if (!remote || remote.revision === 0) {
    // Never reached the server: forget the entry, the scan uploads the file as new.
    await store.deleteEntry(mutation.entryId);
    return;
  }
  if (remote.deleted || !remote.path) {
    await store.clearLocalState(mutation.entryId);
    return;
  }
  await store.applyLocalState({
    entryId: mutation.entryId,
    path: remote.path,
    blobId: remote.blobId,
    hash: remote.hash,
    entryType: remote.entryType,
    deleted: false,
    updatedAt: Date.now(),
    // Unknown on purpose: the scan must re-hash the file instead of trusting a stat.
    localMtime: null,
    localSize: null,
  });
}

// Drops every queued change whose metadata the current key cannot decrypt.
// Returns how many were dropped.
export async function dropUndecryptablePendingMutations(
  store: UndecryptablePendingStore & Pick<SyncMutationStore, "listDirtyEntries">,
  crypto: SyncCryptoService,
): Promise<number> {
  let dropped = 0;
  for (const pending of await store.listDirtyEntries()) {
    if (await tryDecryptPendingMetadata(crypto, pending)) {
      continue;
    }
    await dropUndecryptablePendingMutation(store, pending);
    dropped += 1;
  }
  return dropped;
}
