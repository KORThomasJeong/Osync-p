import { describe, expect, it } from "vitest";

import { resolveEditedAt } from "../mutation-queue";

describe("resolveEditedAt", () => {
  it("returns Date.now() when file mtime is in the future (clamp)", () => {
    const now = 1_700_000_000_000;
    expect(resolveEditedAt({ now: () => now, fileMtime: now + 60_000 })).toBe(now);
  });

  it("returns mtime when mtime <= now", () => {
    const now = 1_700_000_000_000;
    const mtime = now - 86_400_000;
    expect(resolveEditedAt({ now: () => now, fileMtime: mtime })).toBe(mtime);
  });

  it("falls back to Date.now() when mtime is null/undefined", () => {
    const now = 1_700_000_000_000;
    expect(resolveEditedAt({ now: () => now, fileMtime: null })).toBe(now);
    expect(resolveEditedAt({ now: () => now, fileMtime: undefined })).toBe(now);
  });

  it("returns Date.now() when fileMtime <= 0 (invalid)", () => {
    const now = 1_700_000_000_000;
    expect(resolveEditedAt({ now: () => now, fileMtime: 0 })).toBe(now);
    expect(resolveEditedAt({ now: () => now, fileMtime: -5 })).toBe(now);
  });
});
