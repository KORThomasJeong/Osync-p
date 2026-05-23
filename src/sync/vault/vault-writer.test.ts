import { describe, expect, it } from "vitest";

import {
  ensureParentDirectoriesBatch,
  removeVaultPathIfExists,
  writeVaultBinary,
  writeVaultBytes,
  writeVaultText,
  type SyncVaultWriter,
} from "./vault-writer";

describe("vault writer", () => {
  it("creates parent directories and writes markdown as text", async () => {
    const writer = new MemoryVaultWriter();

    await writeVaultBytes(writer, "Folder/Nested/note.md", new TextEncoder().encode("hello"));

    expect(writer.directories).toEqual(new Set(["Folder", "Folder/Nested"]));
    expect(writer.textFiles.get("Folder/Nested/note.md")).toBe("hello");
    expect(writer.binaryFiles.has("Folder/Nested/note.md")).toBe(false);
  });

  it("writes non-markdown bytes as binary", async () => {
    const writer = new MemoryVaultWriter();
    const bytes = new Uint8Array([1, 2, 3]);

    await writeVaultBytes(writer, "Assets/image.png", bytes);

    expect(writer.directories).toEqual(new Set(["Assets"]));
    expect(writer.binaryFiles.get("Assets/image.png")).toEqual(bytes);
    expect(writer.textFiles.has("Assets/image.png")).toBe(false);
  });

  it("supports explicit text, binary, and remove-if-exists operations", async () => {
    const writer = new MemoryVaultWriter();

    await writeVaultText(writer, "Meta/manifest.json", "{}");
    await writeVaultBinary(writer, "Backup/file.bin", new Uint8Array([9]));

    expect(await removeVaultPathIfExists(writer, "Meta/manifest.json")).toBe(true);
    expect(await removeVaultPathIfExists(writer, "missing.md")).toBe(false);
    expect(writer.textFiles.has("Meta/manifest.json")).toBe(false);
    expect(writer.binaryFiles.get("Backup/file.bin")).toEqual(new Uint8Array([9]));
  });
});

describe("ensureParentDirectoriesBatch", () => {
  it("is a no-op on empty array", async () => {
    const writer = new MemoryVaultWriter();

    await ensureParentDirectoriesBatch(writer, []);

    expect(writer.mkdirCalls).toEqual([]);
    expect(writer.directories.size).toBe(0);
  });

  it("creates each unique parent exactly once across many sibling paths", async () => {
    const writer = new MemoryVaultWriter();

    await ensureParentDirectoriesBatch(writer, [
      "a/b/x.md",
      "a/b/y.md",
      "a/b/z.md",
    ]);

    expect(writer.mkdirCalls).toEqual(["a", "a/b"]);
    expect(writer.directories).toEqual(new Set(["a", "a/b"]));
  });

  it("skips mkdir when exists returns true", async () => {
    const writer = new MemoryVaultWriter();
    writer.directories.add("a");
    writer.directories.add("a/b");

    await ensureParentDirectoriesBatch(writer, ["a/b/x.md", "a/b/y.md"]);

    expect(writer.mkdirCalls).toEqual([]);
  });

  it("creates deeper paths in shallow-first order", async () => {
    const writer = new MemoryVaultWriter();

    await ensureParentDirectoriesBatch(writer, ["a/b/c.md", "a/d/e.md"]);

    expect(writer.mkdirCalls).toContain("a");
    expect(writer.mkdirCalls).toContain("a/b");
    expect(writer.mkdirCalls).toContain("a/d");
    expect(writer.mkdirCalls.indexOf("a")).toBeLessThan(
      writer.mkdirCalls.indexOf("a/b"),
    );
    expect(writer.mkdirCalls.indexOf("a")).toBeLessThan(
      writer.mkdirCalls.indexOf("a/d"),
    );
  });

  it("handles top-level files (no parent)", async () => {
    const writer = new MemoryVaultWriter();

    await ensureParentDirectoriesBatch(writer, ["root.md"]);

    expect(writer.mkdirCalls).toEqual([]);
    expect(writer.directories.size).toBe(0);
  });
});

class MemoryVaultWriter implements SyncVaultWriter {
  readonly directories = new Set<string>();
  readonly textFiles = new Map<string, string>();
  readonly binaryFiles = new Map<string, Uint8Array>();
  readonly mkdirCalls: string[] = [];

  async exists(path: string): Promise<boolean> {
    return (
      this.directories.has(path) ||
      this.textFiles.has(path) ||
      this.binaryFiles.has(path)
    );
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls.push(path);
    this.directories.add(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    this.textFiles.set(path, content);
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    this.binaryFiles.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.textFiles.delete(path);
    this.binaryFiles.delete(path);
  }
}
