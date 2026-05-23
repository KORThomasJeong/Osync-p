import { describe, expect, it } from "vitest";
import { TFile, TFolder } from "obsidian";
import { asSyncableFolder } from "./vault-files";
import type { SyncFileRules } from "../core/file-rules";

const ALLOW_ALL_RULES: SyncFileRules = {
  excludedFolders: [],
  includeImages: true,
  includeAudio: true,
  includeVideos: true,
  includePdf: true,
  includeOtherFiles: true,
  includeObsidianConfig: false,
};

describe("asSyncableFolder", () => {
  it("returns TFolder for a syncable folder", () => {
    const folder = new TFolder("MyFolder");
    expect(asSyncableFolder(folder, ALLOW_ALL_RULES)).toBe(folder);
  });

  it("returns null for a TFile", () => {
    const file = new TFile("note.md");
    expect(asSyncableFolder(file, ALLOW_ALL_RULES)).toBeNull();
  });

  it("returns null for excluded folder path", () => {
    const folder = new TFolder("excluded/folder");
    const rules: SyncFileRules = {
      ...ALLOW_ALL_RULES,
      excludedFolders: ["excluded"],
    };
    expect(asSyncableFolder(folder, rules)).toBeNull();
  });
});
