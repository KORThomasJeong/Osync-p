import { hashBytes } from "../core/content";
import type { SyncedEntryMetadata } from "../core/content";
import { mapWithConcurrency } from "../core/concurrency";
import type { SyncCryptoService } from "../core/crypto-service";
import {
  queueLocalDeleteMutation,
  queueLocalFolderUpsertMutation,
  queueLocalUpsertMutation,
  resolveEditedAt,
} from "../core/mutation-queue";
import type {
  LocalSyncEntryRow,
  RemoteSyncEntryRow,
} from "../store/store";
import type {
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
  SyncStoreLifecycle,
} from "../store/ports";
import {
  MassDeleteGuardError,
  shouldTripMassDeleteGuard,
} from "./mass-delete-guard";
import { isAutoMergeTextPath } from "./text-merge-policy";
import { toPathKey } from "../store/dexie/path-key";

export interface LocalSyncFile {
  path: string;
  mtime: number;
  size: number;
  readBytes(): Promise<Uint8Array>;
}

export interface LocalFileScanner {
  listFiles(): Promise<LocalSyncFile[]>;
  listFolders(): string[];
}

export interface SyncLocalReconcileServiceDeps {
  getSyncStore: () => SyncLocalReconcileStore | null;
  crypto: SyncCryptoService;
  scanner: LocalFileScanner;
  shouldSyncPath(path: string): boolean;
  prepareConcurrency?: number;
}

export interface SyncLocalReconcileStore
  extends Pick<SyncEntryStore, "deleteEntry" | "getEntryByPath" | "getOrCreateEntryId">,
    Pick<
      SyncLocalEntryStore,
      "applyLocalState" | "getLocalStateByPath" | "listLocalStates"
    >,
    Pick<SyncRemoteEntryStore, "getRemoteStateById">,
    Pick<
      SyncMutationStore,
      "getDirtyEntryMutation" | "markEntryClean" | "replaceDirtyEntry"
    >,
    Pick<SyncStoreLifecycle, "flush"> {}

export interface ReconcileOnceResult {
  filesScanned: number;
  filesQueuedForUpsert: number;
  filesQueuedForDelete: number;
}

const DEFAULT_PREPARE_CONCURRENCY = 8;

interface PreparedFile {
  file: LocalSyncFile;
  existing: LocalSyncEntryRow | null;
  pendingDeleteEntry: LocalSyncEntryRow | null;
  hash: string | null;
}

export class SyncLocalReconcileService {
  constructor(private readonly deps: SyncLocalReconcileServiceDeps) {}

  async reconcileOnce(options?: {
    allowMassDelete?: boolean;
  }): Promise<ReconcileOnceResult> {
    const store = this.requireStore();
    const localFiles = await this.deps.scanner.listFiles();
    // Membership is keyed by NFC path key: macOS scans return NFD while stored paths are
    // NFC, so a raw string compare treats the same file as missing and queues a ghost
    // delete. Keys normalize both sides; the original paths are still used for I/O.
    const localPathKeys = new Set(localFiles.map((file) => toPathKey(file.path)));
    const knownEntries = await this.filterKnownEntries(store);

    if (!options?.allowMassDelete) {
      const localFolderPathKeys = new Set(
        this.deps.scanner.listFolders().map((path) => toPathKey(path)),
      );
      let deleteCandidates = 0;
      for (const entry of knownEntries) {
        if (entry.deleted || !entry.path) {
          continue;
        }
        if (entry.entryType === "folder") {
          if (!localFolderPathKeys.has(toPathKey(entry.path))) {
            deleteCandidates += 1;
          }
        } else if (!localPathKeys.has(toPathKey(entry.path))) {
          deleteCandidates += 1;
        }
      }
      if (
        shouldTripMassDeleteGuard({
          deleteCount: deleteCandidates,
          knownEntryCount: knownEntries.length,
        })
      ) {
        throw new MassDeleteGuardError({
          deleteCount: deleteCandidates,
          knownEntryCount: knownEntries.length,
        });
      }
    }

    const pendingDeleteEntriesByPath = await this.indexPendingDeleteEntriesByPath(
      store,
      knownEntries,
    );

    // Phase 1: parallel read + hash
    const prepared = await mapWithConcurrency(
      localFiles,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (file): Promise<PreparedFile> => {
        const existing = await store.getLocalStateByPath(file.path);
        const pendingDeleteEntry = pendingDeleteEntriesByPath.get(file.path) ?? null;
        const existingHasPendingDelete =
          !!existing && pendingDeleteEntry?.entryId === existing.entryId;
        if (!existingHasPendingDelete && canSkipHash(existing, file)) {
          return { file, existing, pendingDeleteEntry, hash: null };
        }
        const hash = await hashBytes(await file.readBytes());
        return { file, existing, pendingDeleteEntry, hash };
      },
    );

    // Phase 2: sequential application
    const renameCandidates = new Map<string, LocalSyncEntryRow[]>();
    const reusedEntryIds = new Set<string>();
    let filesQueuedForUpsert = 0;
    let filesQueuedForDelete = 0;

    for (const entry of knownEntries) {
      if (
        entry.deleted ||
        !entry.path ||
        localPathKeys.has(toPathKey(entry.path)) ||
        !entry.hash
      ) {
        continue;
      }

      const bucket = renameCandidates.get(entry.hash) ?? [];
      bucket.push(entry);
      renameCandidates.set(entry.hash, bucket);
    }

    for (const { file, existing, pendingDeleteEntry, hash } of prepared) {
      const existingHasPendingDelete =
        !!existing && pendingDeleteEntry?.entryId === existing.entryId;
      const restoredDeletedEntry = existing ? null : pendingDeleteEntry;

      if (hash === null) {
        continue;
      }

      if (
        existing &&
        !existingHasPendingDelete &&
        !existing.deleted &&
        existing.hash === hash
      ) {
        await store.applyLocalState({
          ...existing,
          localMtime: file.mtime,
          localSize: file.size,
        });
        continue;
      }

      const renameMatch =
        !existing && !restoredDeletedEntry
          ? takeRenameCandidate(renameCandidates, hash)
          : null;
      const entry = existing ?? restoredDeletedEntry ?? renameMatch;
      if (renameMatch) {
        reusedEntryIds.add(renameMatch.entryId);
      }
      const remote = entry
        ? await store.getRemoteStateById(entry.entryId)
        : await getVisibleRemoteEntryByPath(store, file.path);
      const entryId =
        entry?.entryId ?? remote?.entryId ?? (await store.getOrCreateEntryId(file.path));

      const queued = await queueLocalUpsertMutation(store, {
        crypto: this.deps.crypto,
        path: file.path,
        entryId,
        base: remote,
        previousLocal: entry,
        hash,
        editedAt: resolveEditedAt({ now: () => Date.now(), fileMtime: file.mtime }),
        requireBaseBlob: shouldRequireBaseBlob(file.path, remote),
      });
      await store.applyLocalState({
        entryId: queued.entryId,
        path: file.path,
        blobId: queued.blobId,
        hash,
        deleted: false,
        updatedAt: Date.now(),
        localMtime: file.mtime,
        localSize: file.size,
      });
      filesQueuedForUpsert += 1;
    }

    for (const entry of knownEntries) {
      if (
        entry.deleted ||
        !entry.path ||
        localPathKeys.has(toPathKey(entry.path)) ||
        reusedEntryIds.has(entry.entryId) ||
        entry.entryType === "folder"
      ) {
        continue;
      }

      const remote = await store.getRemoteStateById(entry.entryId);
      if (!remote || remote.revision === 0) {
        await store.markEntryClean(entry.entryId);
        await store.deleteEntry(entry.entryId);
        continue;
      }

      const deletedPath = entry.path;
      await queueLocalDeleteMutation(store, {
        crypto: this.deps.crypto,
        entryId: entry.entryId,
        base: remote,
        path: deletedPath,
        editedAt: Date.now(),
      });
      await store.applyLocalState({
        entryId: entry.entryId,
        path: null,
        blobId: null,
        hash: null,
        deleted: true,
        updatedAt: Date.now(),
        localMtime: null,
        localSize: null,
      });
      filesQueuedForDelete += 1;
    }

    await store.flush();

    // Folder reconcile phase. Iterate the original scanned paths (needed for real I/O and
    // mutation payloads) but decide membership on NFC path keys, like the file phase above.
    const localFolderPaths = this.deps.scanner.listFolders();
    const localFolderPathKeys = new Set(localFolderPaths.map((path) => toPathKey(path)));
    const knownFolderEntries = knownEntries.filter((e) => e.entryType === "folder");
    const knownFolderPathKeys = new Set(
      knownFolderEntries
        .filter((e) => !e.deleted && e.path)
        .map((e) => toPathKey(e.path as string)),
    );

    for (const folderPath of localFolderPaths) {
      if (!knownFolderPathKeys.has(toPathKey(folderPath))) {
        const existing = await store.getLocalStateByPath(folderPath);
        const remote = existing ? await store.getRemoteStateById(existing.entryId) : null;
        const entryId =
          existing?.entryId ?? remote?.entryId ?? (await store.getOrCreateEntryId(folderPath));
        await queueLocalFolderUpsertMutation(store, {
          crypto: this.deps.crypto,
          path: folderPath,
          entryId,
          base: remote,
          editedAt: Date.now(),
        });
        await store.applyLocalState({
          entryId,
          path: folderPath,
          blobId: null,
          hash: null,
          entryType: "folder",
          deleted: false,
          updatedAt: Date.now(),
          localMtime: null,
          localSize: null,
        });
        filesQueuedForUpsert += 1;
      }
    }

    for (const entry of knownFolderEntries) {
      if (entry.deleted || !entry.path || localFolderPathKeys.has(toPathKey(entry.path))) {
        continue;
      }
      const remote = await store.getRemoteStateById(entry.entryId);
      if (!remote || remote.revision === 0) {
        await store.markEntryClean(entry.entryId);
        await store.deleteEntry(entry.entryId);
        continue;
      }
      await queueLocalDeleteMutation(store, {
        crypto: this.deps.crypto,
        entryId: entry.entryId,
        base: remote,
        path: entry.path,
        entryType: "folder",
        editedAt: Date.now(),
      });
      await store.applyLocalState({
        entryId: entry.entryId,
        path: null,
        blobId: null,
        hash: null,
        entryType: "folder",
        deleted: true,
        updatedAt: Date.now(),
        localMtime: null,
        localSize: null,
      });
      filesQueuedForDelete += 1;
    }

    await store.flush();

    return {
      filesScanned: localFiles.length,
      filesQueuedForUpsert,
      filesQueuedForDelete,
    };
  }

  private requireStore(): SyncLocalReconcileStore {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    return store;
  }

  private async filterKnownEntries(
    store: SyncLocalReconcileStore,
  ): Promise<LocalSyncEntryRow[]> {
    const knownEntries = await store.listLocalStates();
    const retainedEntries: LocalSyncEntryRow[] = [];

    for (const entry of knownEntries) {
      if (!entry.path || entry.deleted || this.deps.shouldSyncPath(entry.path)) {
        retainedEntries.push(entry);
        continue;
      }

      await store.markEntryClean(entry.entryId);
      const remote = await store.getRemoteStateById(entry.entryId);
      if (!remote || remote.revision === 0) {
        await store.deleteEntry(entry.entryId);
      }
    }

    return retainedEntries;
  }

  private async indexPendingDeleteEntriesByPath(
    store: SyncLocalReconcileStore,
    entries: LocalSyncEntryRow[],
  ): Promise<Map<string, LocalSyncEntryRow>> {
    const entriesById = new Map(entries.map((entry) => [entry.entryId, entry]));
    const result = new Map<string, LocalSyncEntryRow>();

    for (const entry of entries) {
      const pending = await store.getDirtyEntryMutation(entry.entryId);
      if (!pending || pending.op !== "delete") {
        continue;
      }

      let metadata: SyncedEntryMetadata;
      try {
        metadata = await this.deps.crypto.decryptMetadata(
          pending.encryptedMetadata,
          {
            entryId: pending.entryId,
            revision: pending.baseRevision + 1,
            op: pending.op,
            blobId: pending.blobId,
          },
        );
      } catch (error) {
        console.error(
          `[osync] reconcile: failed to decrypt delete mutation entry=${pending.entryId} rev=${pending.baseRevision + 1}`,
          error,
        );
        throw error;
      }
      const pendingEntry = entriesById.get(pending.entryId);
      if (pendingEntry) {
        result.set(metadata.path, pendingEntry);
      }
    }

    return result;
  }
}

function canSkipHash(
  existing: LocalSyncEntryRow | null,
  file: LocalSyncFile,
): boolean {
  return (
    !!existing &&
    !existing.deleted &&
    !!existing.hash &&
    existing.localMtime === file.mtime &&
    existing.localSize === file.size
  );
}

function takeRenameCandidate(
  candidates: Map<string, LocalSyncEntryRow[]>,
  hash: string,
): LocalSyncEntryRow | null {
  const bucket = candidates.get(hash);
  if (!bucket || bucket.length === 0) {
    return null;
  }

  const match = bucket.shift() ?? null;
  if (bucket.length === 0) {
    candidates.delete(hash);
  }

  return match;
}

async function getVisibleRemoteEntryByPath(
  store: SyncLocalReconcileStore,
  path: string,
): Promise<RemoteSyncEntryRow | null> {
  const visible = await store.getEntryByPath(path);
  return visible ? await store.getRemoteStateById(visible.entryId) : null;
}

function shouldRequireBaseBlob(
  path: string,
  remote: RemoteSyncEntryRow | null,
): boolean {
  return !!remote && !remote.deleted && !!remote.blobId && isAutoMergeTextPath(path);
}
