import { describe, expect, it } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import type { RemoteSyncEntryRow } from "../store/store";
import { findExcludedRemoteEntries } from "./purge-excluded";

function remote(overrides: Partial<RemoteSyncEntryRow>): RemoteSyncEntryRow {
  return {
    entryId: "e",
    path: "Notes/a.md",
    revision: 1,
    blobId: "b",
    hash: "h",
    deleted: false,
    updatedAt: 1,
    ...overrides,
  };
}

describe("findExcludedRemoteEntries", () => {
  const rules = { ...DEFAULT_SYNC_FILE_RULES, excludedFolders: ["Wiki/_retrieval"] };

  it("selects live remote entries whose path is in an excluded folder", () => {
    const states = [
      remote({ entryId: "keep", path: "Notes/a.md" }),
      remote({ entryId: "drop-1", path: "Wiki/_retrieval/doc.md" }),
      remote({ entryId: "drop-2", path: "Wiki/_retrieval/sub/other.md" }),
    ];
    const result = findExcludedRemoteEntries(states, rules);
    expect(result.map((s) => s.entryId).sort()).toEqual(["drop-1", "drop-2"]);
  });

  it("ignores already-deleted (tombstoned) entries", () => {
    const states = [remote({ entryId: "t", path: "Wiki/_retrieval/x.md", deleted: true })];
    expect(findExcludedRemoteEntries(states, rules)).toEqual([]);
  });

  it("ignores entries with no path", () => {
    const states = [remote({ entryId: "n", path: null })];
    expect(findExcludedRemoteEntries(states, rules)).toEqual([]);
  });

  it("returns nothing when no excluded folders are configured", () => {
    const states = [remote({ entryId: "a", path: "Wiki/_retrieval/x.md" })];
    expect(findExcludedRemoteEntries(states, DEFAULT_SYNC_FILE_RULES)).toEqual([]);
  });

  it("never selects entries that are only unwritable on this device (path limits, Windows names)", () => {
    const states = [
      remote({ entryId: "long", path: `Notes/${"가".repeat(85)}.md` }),
      remote({ entryId: "win", path: "2026/260719 너희는 나를 누구라 하느냐?.md" }),
      remote({ entryId: "drop", path: "Wiki/_retrieval/doc.md" }),
    ];
    expect(findExcludedRemoteEntries(states, rules).map((s) => s.entryId)).toEqual(["drop"]);
  });
});
