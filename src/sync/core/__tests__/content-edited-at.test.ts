import { describe, expect, it } from "vitest";

import {
  parseSyncedEntryMetadata,
  serializeSyncedEntryMetadata,
} from "../content";

describe("SyncedEntryMetadata.editedAt (backward-compatible)", () => {
  it("serializes editedAt when present", () => {
    const json = serializeSyncedEntryMetadata({
      path: "a.md",
      hash: "abcd",
      editedAt: 1_700_000_000_000,
    });
    expect(JSON.parse(json)).toEqual({
      path: "a.md",
      hash: "abcd",
      editedAt: 1_700_000_000_000,
    });
  });

  it("omits editedAt from output when undefined (no key)", () => {
    const json = serializeSyncedEntryMetadata({ path: "a.md", hash: "abcd" });
    expect("editedAt" in JSON.parse(json)).toBe(false);
  });

  it("parses metadata without editedAt (legacy)", () => {
    const meta = parseSyncedEntryMetadata(
      JSON.stringify({ path: "a.md", hash: "abcd" }),
    );
    expect(meta).toEqual({ path: "a.md", hash: "abcd" });
    expect(meta.editedAt).toBeUndefined();
  });

  it("rejects negative editedAt", () => {
    expect(() =>
      parseSyncedEntryMetadata(
        JSON.stringify({ path: "a.md", hash: "abcd", editedAt: -1 }),
      ),
    ).toThrow(/editedAt/);
  });

  it("rejects non-number editedAt", () => {
    expect(() =>
      parseSyncedEntryMetadata(
        JSON.stringify({ path: "a.md", hash: "abcd", editedAt: "1700" }),
      ),
    ).toThrow(/editedAt/);
  });
});
