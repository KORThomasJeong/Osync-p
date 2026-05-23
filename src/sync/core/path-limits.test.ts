import { describe, expect, it } from "vitest";

import {
  DEFAULT_PATH_LIMITS,
  describePathLimit,
  isPathWithinSyncLimits,
} from "./path-limits";

describe("isPathWithinSyncLimits", () => {
  it("accepts short ASCII paths", () => {
    expect(isPathWithinSyncLimits("notes/foo.md")).toBe(true);
  });

  it("accepts moderate Korean paths", () => {
    expect(isPathWithinSyncLimits("노트/일일/2026-05-23 회의록.md")).toBe(true);
  });

  it("rejects path with filename component over 250 bytes", () => {
    const longFilename = "가".repeat(85) + ".md"; // 85 * 3 + 3 = 258 bytes
    expect(isPathWithinSyncLimits(`notes/${longFilename}`)).toBe(false);
  });

  it("rejects total path over 900 bytes", () => {
    const deep =
      Array.from({ length: 6 }, () => "긴폴더이름".repeat(10)).join("/") +
      "/file.md";
    // each segment is ~150 bytes, 6 of them = ~900+ bytes
    expect(isPathWithinSyncLimits(deep)).toBe(false);
  });

  it("accepts path right at the boundary", () => {
    const filename = "a".repeat(247) + ".md"; // 250 bytes exact
    expect(isPathWithinSyncLimits(filename)).toBe(true);
  });

  it("respects custom limits", () => {
    expect(
      isPathWithinSyncLimits("notes/foo.md", { maxPathBytes: 5, maxFilenameBytes: 100 }),
    ).toBe(false);
  });
});

describe("describePathLimit", () => {
  it("returns ok for short paths", () => {
    expect(describePathLimit("notes/foo.md")).toEqual({ ok: true });
  });

  it("returns filename_too_long for oversized filename", () => {
    const longFilename = "x".repeat(260);
    const result = describePathLimit(`folder/${longFilename}`);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("filename_too_long");
    expect(result.byteSize).toBe(260);
    expect(result.limit).toBe(DEFAULT_PATH_LIMITS.maxFilenameBytes);
  });

  it("returns path_too_long when total path exceeds limit but filename is ok", () => {
    const segment = "a".repeat(100);
    const path = Array.from({ length: 10 }, () => segment).join("/") + "/x.md";
    // ~10 * 101 + 4 = ~1014 bytes total, filename "x.md" is fine
    const result = describePathLimit(path);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("path_too_long");
    expect(result.byteSize).toBeGreaterThan(DEFAULT_PATH_LIMITS.maxPathBytes);
  });

  it("prioritizes filename_too_long over path_too_long when both exceed", () => {
    const longFilename = "y".repeat(300);
    const path =
      Array.from({ length: 5 }, () => "a".repeat(200)).join("/") + `/${longFilename}`;
    const result = describePathLimit(path);
    expect(result.reason).toBe("filename_too_long");
  });
});
