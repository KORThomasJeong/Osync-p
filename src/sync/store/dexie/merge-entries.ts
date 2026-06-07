import {
  buildConflictCopyPath,
  formatConflictTimestamp,
} from "../../core/conflict-file";
import { normalizeEntryRecord } from "./mappers";
import { toPathKey } from "./path-key";
import type { EntryRecord } from "./records";

/**
 * Pure collision-resolution / merge core shared by the Dexie v5 migration and the
 * runtime putEntry recovery.
 *
 * Input: one or more EntryRecords whose localPath / remotePath collapse to the same
 * NFC localPathKey OR remotePathKey (i.e. they refer to the same logical file once
 * macOS NFD paths are normalized to NFC). Output: the records to persist, each already
 * passed through normalizeEntryRecord so its *PathKey fields reflect the NFC form.
 *
 * NFC normalization touches only comparison artifacts (the path keys). localPath /
 * remotePath stay in the OS-returned form for real file I/O — except for conflict-copy
 * losers, whose paths are rewritten to a brand new conflict path (no NFC reconstruction
 * of the original write path).
 */
export function resolvePathKeyCollision(
  records: EntryRecord[],
  now: () => number = Date.now,
): EntryRecord[] {
  if (records.length === 0) {
    return [];
  }
  if (records.length === 1) {
    return [normalizeEntryRecord(records[0])];
  }

  const canonical = pickCanonical(records);
  const losers = records.filter((record) => record !== canonical);

  let merged: EntryRecord = canonical;
  const output: EntryRecord[] = [];
  // Stable conflict timestamp for the whole group; attempt disambiguates collisions.
  const timestamp = formatConflictTimestamp(now());
  let conflictAttempt = 0;

  for (const loser of losers) {
    if (isIdenticalContent(canonical, loser)) {
      merged = mergeOnto(merged, loser);
      const tombstone = toTombstone(loser);
      if (tombstone) {
        output.push(normalizeEntryRecord(tombstone));
      }
      continue;
    }

    const renamed = toConflictCopy(loser, timestamp, conflictAttempt);
    conflictAttempt += 1;
    output.push(normalizeEntryRecord(renamed));
  }

  merged = { ...merged, dirty: true };
  output.unshift(normalizeEntryRecord(merged));
  return output;
}

function pickCanonical(records: EntryRecord[]): EntryRecord {
  const remoteKnown = records.filter((record) => record.remoteKnown);
  const pool = remoteKnown.length > 0 ? remoteKnown : records;
  const useRemote = remoteKnown.length > 0;

  return [...pool].sort((left, right) => compareCanonical(left, right, useRemote))[0];
}

function compareCanonical(
  left: EntryRecord,
  right: EntryRecord,
  useRemote: boolean,
): number {
  if (useRemote) {
    if (left.remoteRevision !== right.remoteRevision) {
      return right.remoteRevision - left.remoteRevision;
    }
    if (left.remoteUpdatedAt !== right.remoteUpdatedAt) {
      return right.remoteUpdatedAt - left.remoteUpdatedAt;
    }
  } else if (left.localUpdatedAt !== right.localUpdatedAt) {
    return right.localUpdatedAt - left.localUpdatedAt;
  }

  return left.entryId.localeCompare(right.entryId);
}

/**
 * The colliding records represent the same content when their meaningful hashes match,
 * or when the loser carries no content hash that differs from the canonical's hashes.
 */
function isIdenticalContent(canonical: EntryRecord, loser: EntryRecord): boolean {
  const canonicalHashes = contentHashes(canonical);
  const loserHashes = contentHashes(loser);

  if (loserHashes.length === 0) {
    return true;
  }

  // Identical when every distinct hash the loser carries is also present on the canonical.
  return loserHashes.every((hash) => canonicalHashes.includes(hash));
}

function contentHashes(record: EntryRecord): string[] {
  const hashes: string[] = [];
  for (const hash of [record.localHash, record.remoteHash, record.baseHash]) {
    if (hash && !hashes.includes(hash)) {
      hashes.push(hash);
    }
  }
  return hashes;
}

/**
 * Unions the loser's known sides onto the canonical so no remote/local knowledge is lost.
 * Existing canonical fields win for any side the canonical already knows.
 */
function mergeOnto(canonical: EntryRecord, loser: EntryRecord): EntryRecord {
  const merged: EntryRecord = { ...canonical };

  if (!canonical.remoteKnown && loser.remoteKnown) {
    merged.remoteKnown = true;
    merged.remotePath = loser.remotePath;
    merged.remoteRevision = loser.remoteRevision;
    merged.remoteBlobId = loser.remoteBlobId;
    merged.remoteHash = loser.remoteHash;
    merged.remoteDeleted = loser.remoteDeleted;
    merged.remoteUpdatedAt = loser.remoteUpdatedAt;
  }

  if (!canonical.localKnown && loser.localKnown) {
    merged.localKnown = true;
    merged.localPath = loser.localPath;
    merged.localBlobId = loser.localBlobId;
    merged.localHash = loser.localHash;
    merged.localDeleted = loser.localDeleted;
    merged.localUpdatedAt = loser.localUpdatedAt;
    merged.localMtime = loser.localMtime;
    merged.localSize = loser.localSize;
  }

  return merged;
}

/**
 * A loser that exists on the server under its own entryId must be deleted there so the
 * server no longer carries a duplicate. Returns a delete tombstone with its path keys
 * cleared (so normalizeEntryRecord yields undefined keys and the index never collides).
 * A loser that was never on the server is dropped (returns null).
 */
function toTombstone(loser: EntryRecord): EntryRecord | null {
  if (!loser.remoteKnown) {
    return null;
  }

  return {
    ...loser,
    localDeleted: true,
    remoteDeleted: true,
    dirty: true,
    pendingOp: "delete",
    pendingStatus: "pending",
  };
}

/**
 * Rewrites a differing loser onto a fresh conflict-copy path so its NFC key no longer
 * collides with the canonical. Both records survive — zero data loss.
 */
function toConflictCopy(
  loser: EntryRecord,
  timestamp: string,
  attempt: number,
): EntryRecord {
  const sourcePath = loser.localPath ?? loser.remotePath ?? loser.basePath ?? "";
  const conflictPath = buildConflictCopyPath(sourcePath, timestamp, attempt);

  const renamed: EntryRecord = { ...loser, dirty: true };
  if (loser.localKnown && loser.localPath !== null) {
    renamed.localPath = conflictPath;
  }
  if (loser.remoteKnown && loser.remotePath !== null) {
    renamed.remotePath = conflictPath;
  }
  return renamed;
}

/**
 * Groups records by their NFC path key so a flat list can be split into independent
 * collision groups before resolution. Exposed for the migration / recovery callers.
 */
export function groupByPathKey(records: EntryRecord[]): EntryRecord[][] {
  const groups = new Map<string, EntryRecord[]>();
  const ungrouped: EntryRecord[] = [];

  for (const record of records) {
    const key = pathKeyOf(record);
    if (key === undefined) {
      ungrouped.push(record);
      continue;
    }
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  const result = [...groups.values()];
  for (const record of ungrouped) {
    result.push([record]);
  }
  return result;
}

function pathKeyOf(record: EntryRecord): string | undefined {
  if (record.localKnown && record.localPath && !record.localDeleted) {
    return `local:${toPathKey(record.localPath)}`;
  }
  if (record.remoteKnown && record.remotePath && !record.remoteDeleted) {
    return `remote:${toPathKey(record.remotePath)}`;
  }
  return undefined;
}
