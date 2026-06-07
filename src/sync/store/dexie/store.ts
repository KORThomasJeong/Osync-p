import type { Plugin } from "obsidian";

import type { BulkEntryApplyOp, SyncStoreCorruptionListener } from "../ports";
import type {
  CachedSyncBlobRow,
  DeletedSyncEntryRow,
  LocalSyncEntryRow,
  MarkEntryDirtyOptions,
  PendingMutationBlockedReason,
  PendingMutationRow,
  RemoteSyncEntryRow,
  SyncConnection,
  SyncEntryRow,
  SyncEntryStateRow,
  SyncProgressCounts,
  SyncStore,
} from "../store";
import {
  METADATA_ID,
  MIN_PENDING_CREATED_AT,
  SyncDexieDatabase,
  syncStoreDbName,
} from "./database";
import {
  clearPendingMutation,
  copyRemoteToBase,
  createEmptyEntryRecord,
  hasPendingMutationRecord,
  isPresent,
  normalizeEntryRecord,
  normalizePendingMutation,
  sortEntryRows,
  toBlobRecord,
  toCachedBlobRow,
  toCombinedEntryRow,
  toDeletedEntryRow,
  toDirtyEntryRecord,
  toEntryStateRow,
  toLocalEntryRow,
  toPendingMutationRow,
  toRemoteEntryRow,
  toSyncConnection,
} from "./mappers";
import { resolvePathKeyCollision } from "./merge-entries";
import { toPathKey } from "./path-key";
import type { EntryRecord, MetadataRecord } from "./records";

export class DexieSyncStore implements SyncStore {
  private readonly db: SyncDexieDatabase;
  private corruptionListener: SyncStoreCorruptionListener | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly localVaultId: string,
  ) {
    this.db = new SyncDexieDatabase(syncStoreDbName(localVaultId));
  }

  setCorruptionListener(listener: SyncStoreCorruptionListener | null): void {
    this.corruptionListener = listener;
  }

  async initialize(): Promise<void> {
    await this.db.open();
  }

  async readLocalVaultId(): Promise<string> {
    return this.localVaultId;
  }

  async readSyncConnection(): Promise<SyncConnection | null> {
    const metadata = await this.readMetadata();
    return toSyncConnection(this.localVaultId, metadata);
  }

  async writeSyncConnection(connection: SyncConnection): Promise<void> {
    const localVaultId = connection.localVaultId.trim();
    const remoteVaultId = connection.remoteVaultId.trim();
    if (!localVaultId || !remoteVaultId) {
      throw new Error("Local and remote vault IDs are required.");
    }
    if (localVaultId !== this.localVaultId) {
      throw new Error("Local sync store belongs to a different local vault.");
    }

    await this.writeMetadata({
      remoteVaultId,
      lastPulledCursor: connection.lastPulledCursor,
      initialSyncMode: connection.initialSyncMode,
      initialSyncComplete: connection.initialSyncComplete,
    });
  }

  async ensureEntry(entryId: string): Promise<void> {
    await this.putEntry(await this.getOrCreateEntryRecord(entryId));
  }

  async getRemoteStateById(entryId: string): Promise<RemoteSyncEntryRow | null> {
    const row = await this.db.entries.get(entryId);
    return row?.remoteKnown ? toRemoteEntryRow(row) : null;
  }

  async getRemoteStateByPath(path: string): Promise<RemoteSyncEntryRow | null> {
    const row = await this.db.entries
      .where("remotePathKey")
      .equals(toPathKey(path))
      .first();
    return row?.remoteKnown ? toRemoteEntryRow(row) : null;
  }

  async listRemoteStates(): Promise<RemoteSyncEntryRow[]> {
    return sortEntryRows(
      (await this.db.entries.toArray())
        .filter((row) => row.remoteKnown)
        .map(toRemoteEntryRow),
    );
  }

  async applyRemoteState(entry: RemoteSyncEntryRow): Promise<void> {
    const existing = await this.getOrCreateEntryRecord(entry.entryId);
    await this.putEntry(buildRemoteUpdate(existing, entry));
  }

  async clearRemoteState(entryId: string): Promise<void> {
    const existing = await this.db.entries.get(entryId);
    if (!existing) {
      return;
    }

    const updated: EntryRecord = {
      ...existing,
      remoteKnown: false,
      remotePath: null,
      remoteRevision: 0,
      remoteBlobId: null,
      remoteHash: null,
      remoteDeleted: true,
      remoteUpdatedAt: 0,
    };
    if (!updated.localKnown && !updated.dirty) {
      await this.db.entries.delete(entryId);
      return;
    }

    await this.putEntry(updated);
  }

  async getLocalStateById(entryId: string): Promise<LocalSyncEntryRow | null> {
    const row = await this.db.entries.get(entryId);
    return row?.localKnown ? toLocalEntryRow(row) : null;
  }

  async getLocalStateByPath(path: string): Promise<LocalSyncEntryRow | null> {
    const row = await this.db.entries
      .where("localPathKey")
      .equals(toPathKey(path))
      .first();
    return row?.localKnown ? toLocalEntryRow(row) : null;
  }

  async listLocalStates(): Promise<LocalSyncEntryRow[]> {
    return sortEntryRows(
      (await this.db.entries.toArray())
        .filter((row) => row.localKnown)
        .map(toLocalEntryRow),
    );
  }

  async countLocalStates(): Promise<number> {
    return await this.db.entries.filter((row) => row.localKnown === true).count();
  }

  async applyLocalState(entry: LocalSyncEntryRow): Promise<void> {
    const existing = await this.getOrCreateEntryRecord(entry.entryId);
    await this.putEntry({
      ...existing,
      localKnown: true,
      localPath: entry.path,
      localBlobId: entry.blobId,
      localHash: entry.hash,
      localDeleted: entry.deleted,
      localUpdatedAt: entry.updatedAt,
      localMtime: entry.localMtime,
      localSize: entry.localSize,
      entryType: entry.entryType ?? existing.entryType ?? "file",
    });
  }

  async clearLocalState(entryId: string): Promise<void> {
    const existing = await this.db.entries.get(entryId);
    if (!existing) {
      return;
    }

    const updated: EntryRecord = {
      ...existing,
      localKnown: false,
      localPath: null,
      localBlobId: null,
      localHash: null,
      localDeleted: true,
      localUpdatedAt: 0,
      localMtime: null,
      localSize: null,
    };
    if (!updated.remoteKnown && !updated.dirty) {
      await this.db.entries.delete(entryId);
      return;
    }

    await this.putEntry(updated);
  }

  async getEntryById(entryId: string): Promise<SyncEntryRow | null> {
    const row = await this.db.entries.get(entryId);
    return row ? toCombinedEntryRow(row) : null;
  }

  async getEntryByPath(path: string): Promise<SyncEntryRow | null> {
    const pathKey = toPathKey(path);
    const local = await this.db.entries
      .where("localPathKey")
      .equals(pathKey)
      .first();
    if (local?.localKnown) {
      return toCombinedEntryRow(local);
    }

    const remote = await this.db.entries
      .where("remotePathKey")
      .equals(pathKey)
      .first();
    if (!remote?.remoteKnown) {
      return null;
    }

    if (remote.localKnown && (remote.localPath === null || toPathKey(remote.localPath) !== pathKey)) {
      return null;
    }
    return toCombinedEntryRow(remote);
  }

  async getEntryStateById(entryId: string): Promise<SyncEntryStateRow | null> {
    const row = await this.db.entries.get(entryId);
    return row ? toEntryStateRow(row) : null;
  }

  async listEntries(): Promise<SyncEntryRow[]> {
    return sortEntryRows(
      (await this.db.entries.toArray())
        .map(toCombinedEntryRow)
        .filter((entry): entry is SyncEntryRow => !!entry),
    );
  }

  async listDeletedEntries(): Promise<DeletedSyncEntryRow[]> {
    return (await this.db.entries.toArray())
      .filter((row) => row.remoteKnown && row.remoteDeleted && row.remoteRevision > 0)
      .map(toDeletedEntryRow)
      .filter(isPresent)
      .sort((left, right) => {
        if (left.deletedAt !== right.deletedAt) {
          return right.deletedAt - left.deletedAt;
        }
        return left.path.localeCompare(right.path);
      });
  }

  async countSyncProgress(): Promise<SyncProgressCounts> {
    const entries = await this.db.entries.toArray();
    let completedEntries = 0;
    let totalEntries = 0;

    for (const entry of entries) {
      const hasPendingMutation = hasPendingMutationRecord(entry);
      const deleted = entry.localKnown
        ? entry.localDeleted
        : entry.remoteKnown
          ? entry.remoteDeleted
          : true;
      if (!hasPendingMutation && deleted) {
        continue;
      }

      totalEntries += 1;
      if (entry.remoteKnown && entry.remoteRevision > 0 && !hasPendingMutation) {
        completedEntries += 1;
      }
    }

    return { completedEntries, totalEntries };
  }

  async getOrCreateEntryId(path: string): Promise<string> {
    const existing = await this.getEntryByPath(path);
    if (existing) {
      return existing.entryId;
    }

    return crypto.randomUUID();
  }

  async upsertEntry(entry: SyncEntryRow): Promise<void> {
    const existing =
      (await this.db.entries.get(entry.entryId)) ??
      createEmptyEntryRecord(entry.entryId);
    await this.putEntry(buildUpsertUpdate(existing, entry));
  }

  async bulkApply(operations: readonly BulkEntryApplyOp[]): Promise<void> {
    if (operations.length === 0) {
      return;
    }

    const ids = Array.from(
      new Set(operations.map((op) => op.entry.entryId)),
    );

    await this.db.transaction("rw", this.db.entries, async () => {
      const existingRows = await this.db.entries.bulkGet(ids);
      const recordById = new Map<string, EntryRecord>();
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        recordById.set(id, existingRows[i] ?? createEmptyEntryRecord(id));
      }

      for (const op of operations) {
        const current = recordById.get(op.entry.entryId)!;
        const next =
          op.kind === "applyRemote"
            ? buildRemoteUpdate(current, op.entry)
            : buildUpsertUpdate(current, op.entry);
        recordById.set(op.entry.entryId, next);
      }

      const normalized = Array.from(recordById.values()).map((record) =>
        normalizeEntryRecord(record),
      );
      await this.db.entries.bulkPut(normalized);
    });
  }

  async deleteEntry(entryId: string): Promise<void> {
    await this.db.entries.delete(entryId);
  }

  async getCursor(): Promise<number> {
    return (await this.readMetadata())?.lastPulledCursor ?? 0;
  }

  async setCursor(cursor: number): Promise<void> {
    const metadata = await this.readMetadata();
    if (!metadata?.remoteVaultId) {
      throw new Error("Sync connection is not initialized.");
    }

    await this.writeMetadata({
      remoteVaultId: metadata.remoteVaultId,
      lastPulledCursor: cursor,
      initialSyncMode: metadata.initialSyncMode,
      initialSyncComplete: metadata.initialSyncComplete,
    });
  }

  async markEntryDirty(
    mutation: PendingMutationRow,
    options: MarkEntryDirtyOptions = {},
  ): Promise<void> {
    const normalized = normalizePendingMutation(mutation);
    if (options.requireBaseBlob) {
      await this.assertRequiredBaseBlob(normalized);
    }
    const entry = await this.getOrCreateEntryRecord(normalized.entryId);
    await this.putEntry(toDirtyEntryRecord(entry, normalized));
  }

  async replaceDirtyEntry(
    mutation: PendingMutationRow,
    options: MarkEntryDirtyOptions = {},
  ): Promise<void> {
    const normalized = normalizePendingMutation(mutation);
    await this.db.transaction("rw", this.db.entries, this.db.blobs, async () => {
      if (options.requireBaseBlob) {
        await this.assertRequiredBaseBlob(normalized);
      }
      const entry = await this.getOrCreateEntryRecord(normalized.entryId);
      await this.putEntry(toDirtyEntryRecord(entry, normalized));
    });
  }

  async getDirtyEntryMutation(entryId: string): Promise<PendingMutationRow | null> {
    const row = await this.db.entries.get(entryId);
    return row ? toPendingMutationRow(row) : null;
  }

  async listDirtyEntries(limit?: number): Promise<PendingMutationRow[]> {
    let collection = this.db.entries
      .where("[pendingStatus+pendingCreatedAt+entryId]")
      .between(
        ["pending", MIN_PENDING_CREATED_AT, ""],
        ["pending", [], []],
      );
    if (limit !== undefined) {
      collection = collection.limit(limit);
    }

    const rows = await collection.toArray();
    return rows.map((row) => toPendingMutationRow(row)).filter(isPresent);
  }

  async updateDirtyEntry(mutation: PendingMutationRow): Promise<void> {
    await this.markEntryDirty(mutation);
  }

  async unblockDirtyEntriesByReason(
    reason: PendingMutationBlockedReason,
  ): Promise<void> {
    const blocked = await this.db.entries
      .where("pendingStatus")
      .equals("blocked")
      .filter((entry) => entry.pendingBlockedReason === reason)
      .toArray();
    await this.db.transaction("rw", this.db.entries, async () => {
      for (const entry of blocked) {
        await this.putEntry({
          ...entry,
          pendingStatus: "pending",
          pendingBlockedReason: null,
        });
      }
    });
  }

  async clearDirtyEntryByMutationId(mutationId: string): Promise<void> {
    const entry = await this.db.entries
      .where("pendingMutationId")
      .equals(mutationId)
      .first();
    if (!entry) {
      return;
    }

    await this.putEntry(clearPendingMutation(entry));
  }

  async markEntryClean(entryId: string): Promise<void> {
    const entry = await this.db.entries.get(entryId);
    if (!entry) {
      return;
    }

    await this.putEntry(clearPendingMutation(entry));
  }

  async getBlob(blobId: string): Promise<CachedSyncBlobRow | null> {
    const row = await this.db.blobs.get(blobId);
    return row ? toCachedBlobRow(row) : null;
  }

  async putBlob(blob: CachedSyncBlobRow): Promise<void> {
    await this.db.blobs.put(toBlobRecord(blob));
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    this.db.close();
  }

  private async getOrCreateEntryRecord(entryId: string): Promise<EntryRecord> {
    return (await this.db.entries.get(entryId)) ?? createEmptyEntryRecord(entryId);
  }

  private async putEntry(entry: EntryRecord): Promise<void> {
    try {
      await this.db.entries.put(normalizeEntryRecord(entry));
    } catch (error) {
      if (isConstraintError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[osync:store-corruption] ConstraintError on entry ${entry.entryId}: ${message}`,
        );
        try {
          await this.recoverFromPathKeyCollision(entry);
          console.error(
            `[osync:store-corruption] auto-merged path-key collision for entry ${entry.entryId}`,
          );
          return;
        } catch (recoveryError) {
          console.error(
            `[osync:store-corruption] auto-merge failed for entry ${entry.entryId}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          );
        }
        try {
          this.corruptionListener?.({
            kind: "constraint_error",
            entryId: entry.entryId,
            message,
          });
        } catch (listenerError) {
          console.error(
            `[osync:store-corruption] listener threw: ${listenerError instanceof Error ? listenerError.message : String(listenerError)}`,
          );
        }
      }
      throw error;
    }
  }

  /**
   * Auto-recovers from a ConstraintError raised when {@link putEntry}'s NFC
   * path key collides with one already held by a different entry (e.g. a macOS
   * NFD vs server NFC duplicate). Looks up the existing colliding row(s),
   * merges them with the incoming entry via {@link resolvePathKeyCollision},
   * then replaces the old rows with the resolved set inside one rw transaction.
   * Throws if no actual collision is found so the caller falls through to the
   * corruption listener.
   */
  private async recoverFromPathKeyCollision(entry: EntryRecord): Promise<void> {
    const normalized = normalizeEntryRecord(entry);

    await this.db.transaction("rw", this.db.entries, async () => {
      const colliders = new Map<string, EntryRecord>();

      if (normalized.localPathKey !== undefined) {
        const row = await this.db.entries
          .where("localPathKey")
          .equals(normalized.localPathKey)
          .first();
        if (row && row.entryId !== normalized.entryId) {
          colliders.set(row.entryId, row);
        }
      }
      if (normalized.remotePathKey !== undefined) {
        const row = await this.db.entries
          .where("remotePathKey")
          .equals(normalized.remotePathKey)
          .first();
        if (row && row.entryId !== normalized.entryId) {
          colliders.set(row.entryId, row);
        }
      }

      if (colliders.size === 0) {
        throw new Error(
          `No path-key collision found for entry ${normalized.entryId}; cannot auto-recover.`,
        );
      }

      const resolved = resolvePathKeyCollision([...colliders.values(), normalized]);

      // Remove the colliding rows and the incoming entry's prior row before
      // writing the resolved set. Local-only losers dropped by the merge have
      // no resolved record, so deleting first prevents a stale row lingering.
      const toDelete = new Set<string>([normalized.entryId, ...colliders.keys()]);
      for (const record of resolved) {
        toDelete.delete(record.entryId);
      }
      if (toDelete.size > 0) {
        await this.db.entries.bulkDelete([...toDelete]);
      }

      await this.db.entries.bulkPut(resolved);
    });
  }

  private async assertRequiredBaseBlob(
    mutation: Required<PendingMutationRow>,
  ): Promise<void> {
    if (!mutation.baseBlobId || !mutation.baseHash) {
      return;
    }

    const blob = await this.db.blobs.get(mutation.baseBlobId);
    if (!blob || blob.hash !== mutation.baseHash) {
      throw new Error(
        `Dirty entry ${mutation.entryId} requires cached base blob ${mutation.baseBlobId}.`,
      );
    }
  }

  private async readMetadata(): Promise<MetadataRecord | null> {
    return (await this.db.metadata.get(METADATA_ID)) ?? null;
  }

  private async writeMetadata(
    metadata: Omit<MetadataRecord, "id">,
  ): Promise<void> {
    await this.db.metadata.put({
      id: METADATA_ID,
      remoteVaultId: metadata.remoteVaultId,
      lastPulledCursor: metadata.lastPulledCursor,
      initialSyncMode: metadata.initialSyncMode,
      initialSyncComplete: metadata.initialSyncComplete,
    });
  }
}

/**
 * Pure helper: applies a remote state row onto an existing entry record.
 * Mirrors {@link DexieSyncStore.applyRemoteState} without DB calls so the
 * logic can be reused by the bulk-write path.
 */
export function buildRemoteUpdate(
  existing: EntryRecord,
  entry: RemoteSyncEntryRow,
): EntryRecord {
  const updated: EntryRecord = {
    ...existing,
    remoteKnown: true,
    remotePath: entry.path,
    remoteRevision: entry.revision,
    remoteBlobId: entry.blobId,
    remoteHash: entry.hash,
    remoteDeleted: entry.deleted,
    remoteUpdatedAt: entry.updatedAt,
    entryType: entry.entryType ?? existing.entryType ?? "file",
  };

  if (!existing.dirty) {
    copyRemoteToBase(updated);
  }

  return updated;
}

/**
 * Pure helper: applies an upsert row that overwrites both remote and local
 * tracking columns. Mirrors {@link DexieSyncStore.upsertEntry} without DB
 * calls so the logic can be reused by the bulk-write path.
 *
 * Note: matches the historical single-call semantics — the upsert resets
 * the record to a baseline tied to the new revision rather than merging on
 * top of pre-existing state. The `existing` argument is accepted for API
 * symmetry with {@link buildRemoteUpdate} but its prior tracking columns
 * are intentionally discarded; only the freshly seeded record is returned.
 */
export function buildUpsertUpdate(
  existing: EntryRecord,
  entry: SyncEntryRow,
): EntryRecord {
  void existing;
  return {
    ...createEmptyEntryRecord(entry.entryId),
    remoteKnown: true,
    remotePath: entry.path,
    remoteRevision: entry.revision,
    remoteBlobId: entry.blobId,
    remoteHash: entry.hash,
    remoteDeleted: entry.deleted,
    remoteUpdatedAt: entry.updatedAt,
    basePath: entry.path,
    baseRevision: entry.revision,
    baseBlobId: entry.blobId,
    baseHash: entry.hash,
    baseDeleted: entry.deleted,
    localKnown: true,
    localPath: entry.path,
    localBlobId: entry.blobId,
    localHash: entry.hash,
    localDeleted: entry.deleted,
    localUpdatedAt: entry.updatedAt,
    localMtime: entry.localMtime,
    localSize: entry.localSize,
    entryType: entry.entryType ?? "file",
  };
}

function isConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && name === "ConstraintError") return true;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && /not unique/i.test(message)) return true;
  return false;
}
