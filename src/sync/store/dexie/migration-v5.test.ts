import { afterEach, describe, expect, it } from "vitest";

import Dexie from "dexie";

import { SyncDexieDatabase } from "./database";
import { createEmptyEntryRecord } from "./mappers";
import { toPathKey } from "./path-key";
import type { EntryRecord } from "./records";

// The unique-index schema shared by every version. The pre-v5 DB stored RAW path keys
// (NFD on macOS) in &localPathKey / &remotePathKey, which only diverge from NFC once
// normalized — the v5 upgrade recomputes them in NFC and merges what now collides.
const ENTRIES_SCHEMA =
  "&entryId,&remotePathKey,&localPathKey,dirty,pendingStatus,pendingMutationId,[dirty+pendingCreatedAt+entryId],[pendingStatus+pendingCreatedAt+entryId]";

// NFC ("가") vs NFD ("ᄀ + ㅏ") forms of the same Korean filename — what macOS returns.
const NFC_NAME = "노트/가.md";
const NFD_NAME = "노트/가.md".normalize("NFD");

let dbCounter = 0;

function uniqueDbName(): string {
  dbCounter += 1;
  return `osync:migration-v5-test:${dbCounter}`;
}

const openDbs: Dexie[] = [];

afterEach(async () => {
  while (openDbs.length > 0) {
    const db = openDbs.pop()!;
    db.close();
    await db.delete();
  }
});

/**
 * Opens a Dexie DB declaring ONLY versions 1-4 (the pre-v5 schema) so records can be
 * seeded with raw NFD/NFC path keys before the v5 upgrade exists. Mirrors the index
 * string the real schema used at v4 — no upgrade handler runs because nothing is empty.
 */
class LegacyDexieDatabase extends Dexie {
  entries!: Dexie.Table<EntryRecord, string>;

  constructor(name: string) {
    super(name);
    for (let version = 1; version <= 4; version += 1) {
      this.version(version).stores({
        metadata: "&id",
        entries: ENTRIES_SCHEMA,
        blobs: "&blobId,hash,role,refEntryId,cachedAt",
      });
    }
  }
}

/**
 * A remoteKnown record whose old-shape &remotePathKey is the RAW (un-normalized) remote
 * path — exactly what the pre-v5 DB persisted before NFC normalization existed.
 */
function makeRemoteRecord(
  overrides: Partial<EntryRecord> & { entryId: string },
): EntryRecord {
  const record: EntryRecord = {
    ...createEmptyEntryRecord(overrides.entryId),
    remoteKnown: true,
    remotePath: NFC_NAME,
    remoteDeleted: false,
    remoteRevision: 1,
    remoteUpdatedAt: 1000,
    remoteHash: "h-remote",
    ...overrides,
  };
  record.remotePathKey = record.remotePath ?? undefined;
  return record;
}

/**
 * A localKnown record whose old-shape &localPathKey is the RAW (un-normalized) local path.
 */
function makeLocalRecord(
  overrides: Partial<EntryRecord> & { entryId: string },
): EntryRecord {
  const record: EntryRecord = {
    ...createEmptyEntryRecord(overrides.entryId),
    localKnown: true,
    localPath: NFD_NAME,
    localDeleted: false,
    localUpdatedAt: 1000,
    localHash: "h-local",
    ...overrides,
  };
  record.localPathKey = record.localPath ?? undefined;
  return record;
}

/** Recompute the NFC index keys from the persisted paths the way the Dexie index does. */
function nfcKeys(record: EntryRecord): { local?: string; remote?: string } {
  const result: { local?: string; remote?: string } = {};
  if (record.localKnown && record.localPath && !record.localDeleted) {
    result.local = toPathKey(record.localPath);
  }
  if (record.remoteKnown && record.remotePath && !record.remoteDeleted) {
    result.remote = toPathKey(record.remotePath);
  }
  return result;
}

function assertNoKeyCollision(records: EntryRecord[]): void {
  const seenLocal = new Set<string>();
  const seenRemote = new Set<string>();
  for (const record of records) {
    const { local, remote } = nfcKeys(record);
    if (local !== undefined) {
      expect(seenLocal.has(local)).toBe(false);
      seenLocal.add(local);
    }
    if (remote !== undefined) {
      expect(seenRemote.has(remote)).toBe(false);
      seenRemote.add(remote);
    }
  }
}

/**
 * Seeds the pre-v5 DB with the given records, closes it, then reopens through the real
 * SyncDexieDatabase so the v5 upgrade fires. Returns every surviving entry. open() rejects
 * if the upgrade hits a Dexie ConstraintError — the regression this migration prevents.
 */
async function runV5Upgrade(seed: EntryRecord[]): Promise<EntryRecord[]> {
  const name = uniqueDbName();

  const legacy = new LegacyDexieDatabase(name);
  await legacy.open();
  await legacy.entries.bulkPut(seed);
  legacy.close();

  const upgraded = new SyncDexieDatabase(name);
  openDbs.push(upgraded);
  await upgraded.open();
  return upgraded.entries.toArray();
}

describe("Dexie v5 migration", () => {
  it("collapses NFC/NFD duplicates of the same file into one canonical NFC entry", async () => {
    // Same logical file persisted twice under the two Unicode forms — entryId-B carries
    // the NFC name, entryId-A the NFD name, same content hash. The raw keys differ in the
    // old DB but collide once normalized to NFC; the loser is dropped (local-only,
    // never on the server) so exactly one canonical survives.
    const nfdEntry = makeLocalRecord({
      entryId: "entry-A",
      localPath: NFD_NAME,
      localHash: "same-content",
      localUpdatedAt: 1000,
    });
    const nfcEntry = makeLocalRecord({
      entryId: "entry-B",
      localPath: NFC_NAME,
      localHash: "same-content",
      localUpdatedAt: 2000,
    });

    const survivors = await runV5Upgrade([nfdEntry, nfcEntry]);

    // Exactly one canonical entry survives for the file.
    expect(survivors).toHaveLength(1);
    const [canonical] = survivors;
    expect(canonical.localKnown).toBe(true);

    // Its *PathKey is NFC; the write path is preserved in its OS-returned form (whichever
    // record won the canonical pick — NFC normalization never rewrites localPath).
    expect(canonical.localPathKey).toBe(toPathKey(NFC_NAME));
    expect(toPathKey(canonical.localPath ?? "")).toBe(toPathKey(NFC_NAME));

    // No ConstraintError (runV5Upgrade would have rejected) and no surviving collision.
    assertNoKeyCollision(survivors);
  });

  it("leaves a remoteKnown loser as a pending-delete tombstone instead of dropping it", async () => {
    // Both copies are on the server with identical content. The colliding loser becomes a
    // delete tombstone so the push pipeline removes its server-side duplicate.
    const winner = makeRemoteRecord({
      entryId: "winner",
      remotePath: NFC_NAME,
      remoteRevision: 9,
      remoteHash: "same-content",
    });
    const loser = makeRemoteRecord({
      entryId: "loser",
      // The old DB persisted the NFD form as this entry's raw remote key.
      remotePath: NFD_NAME,
      remoteRevision: 1,
      remoteHash: "same-content",
    });

    const survivors = await runV5Upgrade([winner, loser]);

    expect(survivors).toHaveLength(2);
    const canonical = survivors.find((r) => r.entryId === "winner");
    const tombstone = survivors.find((r) => r.entryId === "loser");

    expect(canonical?.remotePathKey).toBe(toPathKey(NFC_NAME));

    expect(tombstone).toBeDefined();
    expect(tombstone?.pendingOp).toBe("delete");
    expect(tombstone?.pendingStatus).toBe("pending");
    expect(tombstone?.dirty).toBe(true);
    expect(tombstone?.remoteDeleted).toBe(true);
    expect(tombstone?.localDeleted).toBe(true);
    // Tombstone keys are cleared so the unique index never collides with the canonical.
    expect(tombstone?.remotePathKey).toBeUndefined();
    expect(tombstone?.localPathKey).toBeUndefined();

    assertNoKeyCollision(survivors);
  });

  it("drops a local-only loser entirely (no tombstone) when content is identical", async () => {
    // Neither side is on the server, so the colliding local-only loser is simply dropped:
    // there is nothing for the push pipeline to delete remotely.
    const winner = makeLocalRecord({
      entryId: "entry-keep",
      localPath: NFC_NAME,
      localHash: "same-content",
      localUpdatedAt: 2000,
    });
    const loser = makeLocalRecord({
      entryId: "entry-drop",
      localPath: NFD_NAME,
      localHash: "same-content",
      localUpdatedAt: 1000,
    });

    const survivors = await runV5Upgrade([winner, loser]);

    expect(survivors).toHaveLength(1);
    expect(survivors[0].entryId).toBe("entry-keep");
    expect(survivors.some((r) => r.entryId === "entry-drop")).toBe(false);
    assertNoKeyCollision(survivors);
  });

  it("keeps both records when content differs, renaming the loser to a conflict path", async () => {
    // Same file name (NFC vs NFD) but DIFFERENT content => no merge. Both survive; the
    // loser is rewritten onto a .sync-conflict path so its NFC key no longer collides.
    const winner = makeRemoteRecord({
      entryId: "winner",
      remotePath: NFC_NAME,
      remoteRevision: 5,
      remoteHash: "content-A",
    });
    const loser = makeRemoteRecord({
      entryId: "loser",
      remotePath: NFD_NAME,
      remoteRevision: 1,
      remoteHash: "content-B",
    });

    const survivors = await runV5Upgrade([winner, loser]);

    expect(survivors).toHaveLength(2);
    const canonical = survivors.find((r) => r.entryId === "winner");
    const renamed = survivors.find((r) => r.entryId === "loser");

    expect(canonical?.remotePath).toBe(NFC_NAME);
    expect(canonical?.remotePathKey).toBe(toPathKey(NFC_NAME));

    expect(renamed).toBeDefined();
    expect(renamed?.pendingOp).not.toBe("delete");
    expect(renamed?.dirty).toBe(true);
    // Loser path rewritten to a conflict copy => no longer the original name.
    expect(renamed?.remotePath).not.toBe(NFD_NAME);
    expect(renamed?.remotePath).toContain(".sync-conflict-");

    // Distinct NFC keys for both => no Dexie ConstraintError.
    assertNoKeyCollision(survivors);
  });

  it("normalizes a non-colliding entry's keys to NFC without touching its write path", async () => {
    // A lone NFD entry with no collision still has its key normalized to NFC by the v5
    // upgrade, while its write path is preserved in the OS-returned (NFD) form.
    const lone = makeLocalRecord({ entryId: "solo", localPath: NFD_NAME, localHash: "h" });

    const survivors = await runV5Upgrade([lone]);

    expect(survivors).toHaveLength(1);
    expect(survivors[0].entryId).toBe("solo");
    expect(survivors[0].localPath).toBe(NFD_NAME);
    expect(survivors[0].localPathKey).toBe(toPathKey(NFC_NAME));
  });
});
