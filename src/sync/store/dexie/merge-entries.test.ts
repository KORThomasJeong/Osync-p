import { describe, expect, it } from "vitest";

import { createEmptyEntryRecord } from "./mappers";
import { groupByPathKey, resolvePathKeyCollision } from "./merge-entries";
import { toPathKey } from "./path-key";
import type { EntryRecord } from "./records";

const FIXED_NOW = () => Date.UTC(2026, 5, 7, 1, 2, 3);

// NFC ("가") vs NFD ("ᄀ + ㅏ") forms of the same Korean filename — what macOS returns.
const NFC_NAME = "노트/가.md";
const NFD_NAME = "노트/가.md".normalize("NFD");

function makeRecord(overrides: Partial<EntryRecord>): EntryRecord {
  return { ...createEmptyEntryRecord(overrides.entryId ?? "entry"), ...overrides };
}

function makeRemote(overrides: Partial<EntryRecord>): EntryRecord {
  return makeRecord({
    remoteKnown: true,
    remotePath: NFC_NAME,
    remoteDeleted: false,
    remoteRevision: 1,
    remoteUpdatedAt: 1000,
    remoteHash: "h-remote",
    ...overrides,
  });
}

function makeLocal(overrides: Partial<EntryRecord>): EntryRecord {
  return makeRecord({
    localKnown: true,
    localPath: NFD_NAME,
    localDeleted: false,
    localUpdatedAt: 1000,
    localHash: "h-local",
    ...overrides,
  });
}

/** Recompute NFC index keys from the persisted paths the way the Dexie index does. */
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

describe("resolvePathKeyCollision", () => {
  it("returns a single record normalized, untouched (no-op merge)", () => {
    const record = makeRemote({ entryId: "only" });

    const result = resolvePathKeyCollision([record], FIXED_NOW);

    expect(result).toHaveLength(1);
    expect(result[0].entryId).toBe("only");
    expect(result[0].pendingOp).toBeNull();
    // Path is left in its OS-returned form; only the key is NFC.
    expect(result[0].remotePath).toBe(NFC_NAME);
  });

  it("preserves the OS-returned (NFD) write path while making the key NFC", () => {
    const record = makeLocal({ entryId: "only", localPath: NFD_NAME });

    const [result] = resolvePathKeyCollision([record], FIXED_NOW);

    expect(result.localPath).toBe(NFD_NAME);
    expect(nfcKeys(result).local).toBe(toPathKey(NFC_NAME));
  });

  describe("identical content merges into one canonical", () => {
    it("merges the local-only loser onto the remoteKnown canonical and drops it", () => {
      const remote = makeRemote({ entryId: "remote-id", remoteHash: "same" });
      const localOnly = makeLocal({
        entryId: "local-id",
        localPath: NFD_NAME,
        localHash: "same",
      });

      const result = resolvePathKeyCollision([remote, localOnly], FIXED_NOW);

      // local-only loser is never on the server => dropped, only canonical remains.
      expect(result).toHaveLength(1);
      const canonical = result[0];
      expect(canonical.entryId).toBe("remote-id");
      expect(canonical.remoteKnown).toBe(true);
      expect(canonical.localKnown).toBe(true);
      expect(canonical.localPath).toBe(NFD_NAME);
      expect(canonical.dirty).toBe(true);
      assertNoKeyCollision(result);
    });

    it("picks canonical by highest remoteRevision", () => {
      const low = makeRemote({ entryId: "a", remoteRevision: 1, remoteHash: "x" });
      const high = makeRemote({ entryId: "b", remoteRevision: 5, remoteHash: "x" });

      const result = resolvePathKeyCollision([low, high], FIXED_NOW);
      const canonical = result.find((r) => r.dirty && r.pendingOp !== "delete");

      expect(canonical?.entryId).toBe("b");
    });

    it("breaks revision ties by newest remoteUpdatedAt", () => {
      const older = makeRemote({
        entryId: "a",
        remoteRevision: 2,
        remoteUpdatedAt: 100,
        remoteHash: "x",
      });
      const newer = makeRemote({
        entryId: "b",
        remoteRevision: 2,
        remoteUpdatedAt: 999,
        remoteHash: "x",
      });

      const result = resolvePathKeyCollision([older, newer], FIXED_NOW);
      const canonical = result.find((r) => r.dirty && r.pendingOp !== "delete");

      expect(canonical?.entryId).toBe("b");
    });

    it("breaks remaining ties by lexicographically smallest entryId", () => {
      const beta = makeRemote({
        entryId: "bbb",
        remoteRevision: 2,
        remoteUpdatedAt: 100,
        remoteHash: "x",
      });
      const alpha = makeRemote({
        entryId: "aaa",
        remoteRevision: 2,
        remoteUpdatedAt: 100,
        remoteHash: "x",
      });

      const result = resolvePathKeyCollision([beta, alpha], FIXED_NOW);
      const canonical = result.find((r) => r.dirty && r.pendingOp !== "delete");

      expect(canonical?.entryId).toBe("aaa");
    });

    it("uses local tiebreak (localUpdatedAt then entryId) when none are remoteKnown", () => {
      const older = makeLocal({
        entryId: "zzz",
        localUpdatedAt: 50,
        localHash: "x",
      });
      const newer = makeLocal({
        entryId: "yyy",
        localUpdatedAt: 200,
        localHash: "x",
      });

      const result = resolvePathKeyCollision([older, newer], FIXED_NOW);
      const canonical = result.find((r) => r.dirty && r.pendingOp !== "delete");

      // newest localUpdatedAt wins; both local-only so the loser is dropped.
      expect(canonical?.entryId).toBe("yyy");
      expect(result).toHaveLength(1);
    });

    it("turns a remoteKnown loser into a delete tombstone with cleared keys", () => {
      const canonical = makeRemote({
        entryId: "winner",
        remoteRevision: 9,
        remoteHash: "same",
      });
      const loser = makeRemote({
        entryId: "loser",
        remoteRevision: 1,
        remoteHash: "same",
      });

      const result = resolvePathKeyCollision([canonical, loser], FIXED_NOW);

      expect(result).toHaveLength(2);
      const tombstone = result.find((r) => r.entryId === "loser");
      expect(tombstone).toBeDefined();
      expect(tombstone?.pendingOp).toBe("delete");
      expect(tombstone?.pendingStatus).toBe("pending");
      expect(tombstone?.dirty).toBe(true);
      expect(tombstone?.remoteDeleted).toBe(true);
      expect(tombstone?.localDeleted).toBe(true);
      // Cleared keys: normalizeEntryRecord must yield undefined for a deleted side.
      expect(tombstone?.remotePathKey).toBeUndefined();
      expect(tombstone?.localPathKey).toBeUndefined();
      // The surviving server entryId is kept so the push pipeline can delete it.
      expect(tombstone?.entryId).toBe("loser");
      assertNoKeyCollision(result);
    });

    it("treats a loser carrying no distinct content hash as identical", () => {
      const canonical = makeRemote({ entryId: "c", remoteHash: "real" });
      // remoteKnown loser with no hashes at all (carries no distinct content).
      const loser = makeRemote({
        entryId: "l",
        remoteHash: null,
        baseHash: null,
        localHash: null,
      });

      const result = resolvePathKeyCollision([canonical, loser], FIXED_NOW);
      const tombstone = result.find((r) => r.entryId === "l");

      expect(tombstone?.pendingOp).toBe("delete");
    });
  });

  describe("different content => conflict-copy rename keeps both", () => {
    it("renames the differing loser to a conflict-copy path with a distinct key", () => {
      const canonical = makeRemote({
        entryId: "winner",
        remoteRevision: 5,
        remotePath: NFC_NAME,
        remoteHash: "content-A",
      });
      const loser = makeLocal({
        entryId: "loser",
        localPath: NFD_NAME,
        localHash: "content-B",
      });

      const result = resolvePathKeyCollision([canonical, loser], FIXED_NOW);

      expect(result).toHaveLength(2);
      const survived = result.find((r) => r.entryId === "loser");
      expect(survived).toBeDefined();
      expect(survived?.pendingOp).not.toBe("delete");
      expect(survived?.dirty).toBe(true);
      // Loser path rewritten to a conflict copy => no longer the original name.
      expect(survived?.localPath).not.toBe(NFD_NAME);
      expect(survived?.localPath).toContain(".sync-conflict-");
      // Both records keep distinct NFC keys: no Dexie ConstraintError.
      assertNoKeyCollision(result);
    });

    it("disambiguates multiple differing losers into separate conflict paths", () => {
      const canonical = makeLocal({
        entryId: "c",
        localPath: NFD_NAME,
        localHash: "A",
        localUpdatedAt: 9999,
      });
      const loser1 = makeLocal({ entryId: "l1", localPath: NFD_NAME, localHash: "B" });
      const loser2 = makeLocal({ entryId: "l2", localPath: NFD_NAME, localHash: "C" });

      const result = resolvePathKeyCollision([canonical, loser1, loser2], FIXED_NOW);

      expect(result).toHaveLength(3);
      assertNoKeyCollision(result);
    });
  });

  describe("determinism", () => {
    it("produces the same canonical regardless of input order", () => {
      const a = makeRemote({ entryId: "a", remoteRevision: 5, remoteHash: "x" });
      const b = makeRemote({ entryId: "b", remoteRevision: 2, remoteHash: "x" });
      const c = makeRemote({ entryId: "c", remoteRevision: 5, remoteHash: "x" });

      const canonicalOf = (records: EntryRecord[]) =>
        resolvePathKeyCollision(records, FIXED_NOW).find(
          (r) => r.dirty && r.pendingOp !== "delete",
        )?.entryId;

      // Revision 5 ties between "a" and "c" => smallest entryId "a" wins regardless of order.
      expect(canonicalOf([a, b, c])).toBe("a");
      expect(canonicalOf([c, b, a])).toBe("a");
      expect(canonicalOf([b, c, a])).toBe("a");
    });

    it("yields an order-independent set of output entryIds", () => {
      const a = makeRemote({ entryId: "a", remoteRevision: 5, remoteHash: "same" });
      const b = makeRemote({ entryId: "b", remoteRevision: 2, remoteHash: "same" });

      const ids = (records: EntryRecord[]) =>
        resolvePathKeyCollision(records, FIXED_NOW)
          .map((r) => r.entryId)
          .sort();

      expect(ids([a, b])).toEqual(ids([b, a]));
    });
  });
});

describe("groupByPathKey", () => {
  it("groups NFC and NFD forms of the same name into one collision group", () => {
    const nfc = makeLocal({ entryId: "nfc", localPath: NFC_NAME });
    const nfd = makeLocal({ entryId: "nfd", localPath: NFD_NAME });
    const other = makeLocal({ entryId: "other", localPath: "노트/다른.md" });

    const groups = groupByPathKey([nfc, nfd, other]);

    const collisionGroup = groups.find((g) => g.length > 1);
    expect(collisionGroup?.map((r) => r.entryId).sort()).toEqual(["nfc", "nfd"]);
    expect(groups.some((g) => g.length === 1 && g[0].entryId === "other")).toBe(true);
  });

  it("keeps records with no active path key as their own singleton groups", () => {
    const deleted = makeRecord({ entryId: "gone", remoteKnown: true, remoteDeleted: true });

    const groups = groupByPathKey([deleted]);

    expect(groups).toEqual([[deleted]]);
  });
});
