import { describe, expect, it, vi } from "vitest";

import {
  deleteConflictCopies,
  findConflictCopies,
  type ConflictCleanupRemover,
  type ConflictCleanupScanner,
} from "./conflict-cleanup";

function makeScanner(
  files: Array<{ path: string; size: number; mtime: number }>,
): ConflictCleanupScanner {
  return {
    listFiles: async () => files,
  };
}

describe("findConflictCopies", () => {
  it("matches files with sync-conflict timestamp suffix", async () => {
    const scanner = makeScanner([
      { path: "notes/foo.sync-conflict-20260520-143022.md", size: 100, mtime: 1 },
      { path: "notes/bar.md", size: 50, mtime: 2 },
      { path: "img.sync-conflict-20260520-143022.png", size: 200, mtime: 3 },
      { path: "img.sync-conflict-20260520-143022-2.png", size: 200, mtime: 4 },
    ]);
    const result = await findConflictCopies(scanner);
    expect(result.map((r) => r.path)).toEqual([
      "img.sync-conflict-20260520-143022-2.png",
      "img.sync-conflict-20260520-143022.png",
      "notes/foo.sync-conflict-20260520-143022.md",
    ]);
  });

  it("rejects malformed conflict patterns", async () => {
    const scanner = makeScanner([
      { path: "notes/foo.sync-conflict.md", size: 100, mtime: 1 },
      { path: "notes/sync-conflict-20260520-143022.md", size: 100, mtime: 2 },
      { path: "notes/foo.sync-conflict-2026.md", size: 100, mtime: 3 },
      { path: "regular.md", size: 100, mtime: 4 },
    ]);
    const result = await findConflictCopies(scanner);
    expect(result).toEqual([]);
  });

  it("sorts results by mtime descending (newest first)", async () => {
    const scanner = makeScanner([
      { path: "a.sync-conflict-20260520-143022.md", size: 1, mtime: 100 },
      { path: "b.sync-conflict-20260520-143022.md", size: 1, mtime: 300 },
      { path: "c.sync-conflict-20260520-143022.md", size: 1, mtime: 200 },
    ]);
    const result = await findConflictCopies(scanner);
    expect(result.map((r) => r.path)).toEqual([
      "b.sync-conflict-20260520-143022.md",
      "c.sync-conflict-20260520-143022.md",
      "a.sync-conflict-20260520-143022.md",
    ]);
  });

  it("returns empty array for empty vault", async () => {
    const scanner = makeScanner([]);
    expect(await findConflictCopies(scanner)).toEqual([]);
  });
});

describe("deleteConflictCopies", () => {
  function makeRemover(failPaths: string[] = []): {
    remover: ConflictCleanupRemover;
    removed: string[];
  } {
    const removed: string[] = [];
    return {
      removed,
      remover: {
        remove: vi.fn(async (path: string) => {
          if (failPaths.includes(path)) {
            throw new Error(`forced failure for ${path}`);
          }
          removed.push(path);
        }),
      },
    };
  }

  it("returns success count when all deletes succeed", async () => {
    const { remover } = makeRemover();
    const result = await deleteConflictCopies(remover, ["a.md", "b.md", "c.md"]);
    expect(result).toEqual({ successCount: 3, failures: [] });
  });

  it("aggregates partial failures without aborting", async () => {
    const { remover, removed } = makeRemover(["b.md"]);
    const result = await deleteConflictCopies(remover, ["a.md", "b.md", "c.md"]);
    expect(result.successCount).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe("b.md");
    expect(removed).toEqual(["a.md", "c.md"]);
  });

  it("reports zero successes when all fail", async () => {
    const { remover } = makeRemover(["a.md", "b.md"]);
    const result = await deleteConflictCopies(remover, ["a.md", "b.md"]);
    expect(result.successCount).toBe(0);
    expect(result.failures).toHaveLength(2);
  });

  it("processes paths in chunks of chunkSize", async () => {
    const { remover, removed } = makeRemover();
    const paths = Array.from({ length: 150 }, (_, i) => `f${i}.md`);
    const onProgress = vi.fn();
    const result = await deleteConflictCopies(remover, paths, {
      chunkSize: 50,
      onProgress,
    });
    expect(result.successCount).toBe(150);
    expect(removed).toHaveLength(150);
    expect(onProgress).toHaveBeenCalledWith(50, 150);
    expect(onProgress).toHaveBeenCalledWith(100, 150);
    expect(onProgress).toHaveBeenCalledWith(150, 150);
  });

  it("returns empty result for empty input", async () => {
    const { remover } = makeRemover();
    const result = await deleteConflictCopies(remover, []);
    expect(result).toEqual({ successCount: 0, failures: [] });
  });
});
