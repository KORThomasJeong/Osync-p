import type { SyncCryptoService } from "./crypto-service";
import type { SyncMutationStore } from "../store/ports";
import type { PendingMutationRow } from "../store/store";

export type PendingMutationWriter = Pick<SyncMutationStore, "replaceDirtyEntry">;

export function resolveEditedAt(input: {
  now: () => number;
  fileMtime: number | null | undefined;
}): number {
  const now = input.now();
  const mtime = input.fileMtime;
  if (mtime === null || mtime === undefined || !Number.isFinite(mtime) || mtime <= 0) {
    return now;
  }
  return Math.min(mtime, now);
}

export interface ReplacePendingMutationInput {
  entryId: string;
  op: "upsert" | "delete";
  entryType?: "file" | "folder";
  baseRevision: number;
  baseBlobId: string | null;
  baseHash: string | null;
  blobId: string | null;
  hash: string | null;
  encryptedMetadata: string;
  createdAt?: number;
  requireBaseBlob?: boolean;
  pathToken?: string | null;
}

export async function replacePendingMutationForEntry(
  store: PendingMutationWriter,
  input: ReplacePendingMutationInput,
): Promise<PendingMutationRow> {
  const queued: PendingMutationRow = {
    mutationId: crypto.randomUUID(),
    entryId: input.entryId,
    op: input.op,
    entryType: input.entryType,
    baseRevision: input.baseRevision,
    baseBlobId: input.baseBlobId,
    baseHash: input.baseHash,
    blobId: input.blobId,
    hash: input.hash,
    encryptedMetadata: input.encryptedMetadata,
    createdAt: input.createdAt ?? Date.now(),
    pathToken: input.pathToken ?? null,
  };

  await store.replaceDirtyEntry(queued, {
    requireBaseBlob: input.requireBaseBlob,
  });
  return queued;
}

export interface QueueLocalUpsertMutationInput {
  crypto: SyncCryptoService;
  path: string;
  entryId: string;
  base: MutationBase | null | undefined;
  previousLocal?: MutationLocalContent | null | undefined;
  hash: string;
  editedAt: number;
  requireBaseBlob?: boolean;
}

export interface MutationBase {
  revision: number;
  deleted: boolean;
  blobId: string | null;
  hash: string | null;
}

export interface MutationLocalContent {
  deleted: boolean;
  blobId: string | null;
  hash: string | null;
}

export interface QueuedLocalUpsertMutation {
  entryId: string;
  blobId: string;
  mutation: PendingMutationRow;
}

export async function queueLocalUpsertMutation(
  store: PendingMutationWriter,
  input: QueueLocalUpsertMutationInput,
): Promise<QueuedLocalUpsertMutation> {
  const entryId = input.entryId;
  const baseRevision = input.base?.revision ?? 0;
  const blobId = createNextBlobId(input.previousLocal ?? input.base, input.hash);
  const pathToken = await input.crypto.derivePathToken(input.path);
  const mutation = await replacePendingMutationForEntry(store, {
    entryId,
    op: "upsert",
    baseRevision,
    baseBlobId: input.base?.blobId ?? null,
    baseHash: input.base?.hash ?? null,
    blobId,
    hash: input.hash,
    encryptedMetadata: await input.crypto.encryptMetadata(
      {
        path: input.path,
        hash: input.hash,
        editedAt: input.editedAt,
      },
      {
        entryId,
        revision: baseRevision + 1,
        op: "upsert",
        blobId,
      },
    ),
    requireBaseBlob: input.requireBaseBlob,
    pathToken,
  });

  return {
    entryId,
    blobId,
    mutation,
  };
}

export interface QueueLocalDeleteMutationInput {
  crypto: SyncCryptoService;
  entryId: string;
  base: MutationBase;
  path: string;
  entryType?: "file" | "folder";
  editedAt: number;
}

export async function queueLocalDeleteMutation(
  store: PendingMutationWriter,
  input: QueueLocalDeleteMutationInput,
): Promise<PendingMutationRow> {
  return await replacePendingMutationForEntry(store, {
    entryId: input.entryId,
    op: "delete",
    entryType: input.entryType,
    baseRevision: input.base.revision,
    baseBlobId: input.base.blobId,
    baseHash: input.base.hash,
    blobId: null,
    hash: null,
    encryptedMetadata: await input.crypto.encryptMetadata(
      {
        path: input.path,
        hash: null,
        editedAt: input.editedAt,
      },
      {
        entryId: input.entryId,
        revision: input.base.revision + 1,
        op: "delete",
        blobId: null,
      },
    ),
  });
}

export function createNextBlobId(
  entry:
    | {
        deleted: boolean;
        blobId: string | null;
        hash: string | null;
      }
    | null
    | undefined,
  hash: string,
): string {
  if (entry && !entry.deleted && entry.hash === hash && entry.blobId) {
    return entry.blobId;
  }

  return crypto.randomUUID();
}

export interface QueueLocalFolderUpsertMutationInput {
  crypto: SyncCryptoService;
  path: string;
  entryId: string;
  base: MutationBase | null | undefined;
  editedAt: number;
}

export async function queueLocalFolderUpsertMutation(
  store: PendingMutationWriter,
  input: QueueLocalFolderUpsertMutationInput,
): Promise<PendingMutationRow> {
  const entryId = input.entryId;
  const baseRevision = input.base?.revision ?? 0;
  const pathToken = await input.crypto.derivePathToken(input.path);
  return await replacePendingMutationForEntry(store, {
    entryId,
    op: "upsert",
    entryType: "folder",
    baseRevision,
    baseBlobId: input.base?.blobId ?? null,
    baseHash: input.base?.hash ?? null,
    blobId: null,
    hash: null,
    encryptedMetadata: await input.crypto.encryptMetadata(
      { path: input.path, hash: null, editedAt: input.editedAt },
      { entryId, revision: baseRevision + 1, op: "upsert", blobId: null },
    ),
    pathToken,
  });
}
