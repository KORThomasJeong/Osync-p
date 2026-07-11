import { hashBytes } from "../core/content";
import type { SyncCryptoService } from "../core/crypto-service";
import type { SyncEventGateLike } from "./event-gate";
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
import { isAutoMergeTextPath } from "./text-merge-policy";

export interface SyncEventRecorderDeps {
  getSyncStore: () => SyncEventRecorderStore | null;
  crypto: SyncCryptoService;
  eventGate?: Pick<SyncEventGateLike, "isSuppressed" | "noteSuppressedEvent">;
}

export interface SyncEventRecorderStore
  extends Pick<SyncEntryStore, "deleteEntry" | "getEntryByPath" | "getOrCreateEntryId">,
    Pick<
      SyncLocalEntryStore,
      "applyLocalState" | "getLocalStateById" | "getLocalStateByPath"
    >,
    Pick<
      SyncRemoteEntryStore,
      "getRemoteStateById" | "getRemoteStateByPath"
    >,
    Pick<
      SyncMutationStore,
      | "getDirtyEntryMutation"
      | "listDirtyEntries"
      | "markEntryClean"
      | "replaceDirtyEntry"
    >,
    Pick<SyncStoreLifecycle, "flush"> {}

export interface LocalFileStat {
  mtime: number;
  size: number;
}

export class SyncEventRecorder {
  constructor(private readonly deps: SyncEventRecorderDeps) {}

  async recordUpsert(
    path: string,
    bytes: Uint8Array,
    localStat: LocalFileStat | null = null,
  ): Promise<boolean> {
    if (this.isSuppressed(path)) {
      this.noteSuppressed(path);
      return false;
    }

    const store = this.requireStore();
    const existing =
      (await store.getLocalStateByPath(path)) ??
      (await this.findPendingDeleteLocalEntryByPath(store, path));
    const remote = existing
      ? await store.getRemoteStateById(existing.entryId)
      : await getVisibleRemoteEntryByPath(store, path);
    const entryId = existing?.entryId ?? remote?.entryId ?? (await store.getOrCreateEntryId(path));
    const hash = await hashBytes(bytes);
    if (existing && !existing.deleted && existing.hash === hash) {
      const pending = await store.getDirtyEntryMutation(existing.entryId);
      if (!pending || (pending.op === "upsert" && pending.hash === hash)) {
        if (
          localStat &&
          (existing.localMtime !== localStat.mtime || existing.localSize !== localStat.size)
        ) {
          await store.applyLocalState({
            ...existing,
            localMtime: localStat.mtime,
            localSize: localStat.size,
          });
          await store.flush();
        }
        return false;
      }
    }

    const queued = await queueLocalUpsertMutation(store, {
      crypto: this.deps.crypto,
      path,
      entryId,
      base: remote,
      previousLocal: existing,
      hash,
      editedAt: resolveEditedAt({ now: () => Date.now(), fileMtime: localStat?.mtime }),
      requireBaseBlob: shouldRequireBaseBlob(path, remote),
    });
    const nextEntry = buildLocalEntrySnapshot(existing, {
      entryId: queued.entryId,
      path,
      blobId: queued.blobId,
      hash,
      deleted: false,
      updatedAt: Date.now(),
      localMtime: localStat?.mtime ?? null,
      localSize: localStat?.size ?? null,
    });

    await store.applyLocalState(nextEntry);
    await store.flush();
    return true;
  }

  async recordRename(
    oldPath: string,
    nextPath: string,
    bytes: Uint8Array,
    localStat: LocalFileStat | null = null,
  ): Promise<boolean> {
    if (this.isSuppressed(oldPath) || this.isSuppressed(nextPath)) {
      this.noteSuppressed(oldPath);
      this.noteSuppressed(nextPath);
      return false;
    }

    const store = this.requireStore();
    const existing =
      (await store.getLocalStateByPath(oldPath)) ??
      (await store.getLocalStateByPath(nextPath));
    if (!existing) {
      return await this.recordUpsert(nextPath, bytes);
    }
    const remote = await store.getRemoteStateById(existing.entryId);

    const hash = await hashBytes(bytes);
    if (existing.path === nextPath && !existing.deleted && existing.hash === hash) {
      const pending = await store.getDirtyEntryMutation(existing.entryId);
      if (!pending || (pending.op === "upsert" && pending.hash === hash)) {
        if (
          localStat &&
          (existing.localMtime !== localStat.mtime || existing.localSize !== localStat.size)
        ) {
          await store.applyLocalState({
            ...existing,
            localMtime: localStat.mtime,
            localSize: localStat.size,
          });
          await store.flush();
        }
        return false;
      }
    }

    const queued = await queueLocalUpsertMutation(store, {
      crypto: this.deps.crypto,
      path: nextPath,
      entryId: existing.entryId,
      base: remote,
      previousLocal: existing,
      hash,
      editedAt: resolveEditedAt({ now: () => Date.now(), fileMtime: localStat?.mtime }),
      requireBaseBlob: shouldRequireBaseBlob(nextPath, remote),
    });
    await store.applyLocalState(
      buildLocalEntrySnapshot(existing, {
        path: nextPath,
        blobId: queued.blobId,
        hash,
        deleted: false,
        updatedAt: Date.now(),
        localMtime: localStat?.mtime ?? null,
        localSize: localStat?.size ?? null,
      }),
    );
    await store.flush();
    return true;
  }

  async recordDelete(path: string): Promise<boolean> {
    if (this.isSuppressed(path)) {
      this.noteSuppressed(path);
      return false;
    }

    const store = this.requireStore();
    const existing =
      (await store.getLocalStateByPath(path)) ??
      (await store.getRemoteStateByPath(path));
    if (!existing) {
      return false;
    }

    await store.markEntryClean(existing.entryId);
    const remote = await store.getRemoteStateById(existing.entryId);

    if (!remote || remote.revision === 0) {
      await store.deleteEntry(existing.entryId);
      await store.flush();
      return false;
    }

    await store.applyLocalState(
      buildLocalEntrySnapshot(await store.getLocalStateById(existing.entryId), {
        entryId: existing.entryId,
        path: null,
        blobId: null,
        hash: null,
        deleted: true,
        updatedAt: Date.now(),
        localMtime: null,
        localSize: null,
      }),
    );
    await queueLocalDeleteMutation(store, {
      crypto: this.deps.crypto,
      entryId: existing.entryId,
      base: remote,
      path,
      editedAt: Date.now(),
    });
    await store.flush();
    return true;
  }

  async recordFolderUpsert(path: string): Promise<boolean> {
    const store = this.requireStore();
    const existing =
      (await store.getLocalStateByPath(path)) ??
      (await store.getRemoteStateByPath(path));
    if (existing && !existing.deleted && existing.entryType === "folder") {
      return false;
    }
    const remote = existing ? await store.getRemoteStateById(existing.entryId) : null;
    const entryId =
      existing?.entryId ?? remote?.entryId ?? (await store.getOrCreateEntryId(path));

    await queueLocalFolderUpsertMutation(store, {
      crypto: this.deps.crypto,
      path,
      entryId,
      base: remote,
      editedAt: Date.now(),
    });
    await store.applyLocalState({
      entryId,
      path,
      blobId: null,
      hash: null,
      entryType: "folder",
      deleted: false,
      updatedAt: Date.now(),
      localMtime: null,
      localSize: null,
    });
    await store.flush();
    return true;
  }

  async recordFolderDelete(path: string): Promise<boolean> {
    return await this.recordDelete(path);
  }

  async recordFolderRename(oldPath: string, newPath: string): Promise<boolean> {
    const store = this.requireStore();
    const existing =
      (await store.getLocalStateByPath(oldPath)) ??
      (await store.getLocalStateByPath(newPath));
    if (!existing) {
      return await this.recordFolderUpsert(newPath);
    }
    const remote = await store.getRemoteStateById(existing.entryId);
    if (existing.path === newPath && !existing.deleted && existing.entryType === "folder") {
      return false;
    }

    await queueLocalFolderUpsertMutation(store, {
      crypto: this.deps.crypto,
      path: newPath,
      entryId: existing.entryId,
      base: remote,
      editedAt: Date.now(),
    });
    await store.applyLocalState({
      entryId: existing.entryId,
      path: newPath,
      blobId: null,
      hash: null,
      entryType: "folder",
      deleted: false,
      updatedAt: Date.now(),
      localMtime: null,
      localSize: null,
    });
    await store.flush();
    return true;
  }

  private isSuppressed(path: string): boolean {
    return this.deps.eventGate?.isSuppressed(path) ?? false;
  }

  // Record that a real vault event was dropped because its path was suppressed, so the
  // gate can replay it once the suppression window closes (avoids losing a user edit
  // that landed during a pull's write).
  private noteSuppressed(path: string): void {
    this.deps.eventGate?.noteSuppressedEvent(path);
  }

  private requireStore(): SyncEventRecorderStore {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    return store;
  }

  private async findPendingDeleteLocalEntryByPath(
    store: SyncEventRecorderStore,
    path: string,
  ): Promise<LocalSyncEntryRow | null> {
    for (const pending of await store.listDirtyEntries()) {
      if (pending.op !== "delete") {
        continue;
      }

      const metadata = await this.deps.crypto.decryptMetadata(
        pending.encryptedMetadata,
        {
          entryId: pending.entryId,
          revision: pending.baseRevision + 1,
          op: pending.op,
          blobId: pending.blobId,
        },
      );
      if (metadata.path !== path) {
        continue;
      }

      return await store.getLocalStateById(pending.entryId);
    }

    return null;
  }
}

function buildLocalEntrySnapshot(
  existing: LocalSyncEntryRow | RemoteSyncEntryRow | null,
  overrides: Partial<LocalSyncEntryRow> & Pick<LocalSyncEntryRow, "updatedAt" | "deleted">,
): LocalSyncEntryRow {
  return {
    entryId: overrides.entryId ?? existing?.entryId ?? crypto.randomUUID(),
    path: overrides.path !== undefined ? overrides.path : (existing?.path ?? null),
    blobId: overrides.blobId !== undefined ? overrides.blobId : (existing?.blobId ?? null),
    hash:
      overrides.hash !== undefined
        ? overrides.hash
        : (existing?.hash ?? null),
    deleted: overrides.deleted,
    updatedAt: overrides.updatedAt,
    localMtime:
      overrides.localMtime !== undefined
        ? overrides.localMtime
        : localMtimeOf(existing),
    localSize:
      overrides.localSize !== undefined
        ? overrides.localSize
        : localSizeOf(existing),
  };
}

function localMtimeOf(
  entry: LocalSyncEntryRow | RemoteSyncEntryRow | null,
): number | null {
  return entry && "localMtime" in entry ? entry.localMtime : null;
}

function localSizeOf(
  entry: LocalSyncEntryRow | RemoteSyncEntryRow | null,
): number | null {
  return entry && "localSize" in entry ? entry.localSize : null;
}

async function getVisibleRemoteEntryByPath(
  store: SyncEventRecorderStore,
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
