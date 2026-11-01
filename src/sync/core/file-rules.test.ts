import { describe, expect, it } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  matchesSyncEntryRules,
  matchesSyncFileRules,
  matchesSyncFolderRules,
  normalizeExcludedFolders,
  normalizeSyncFileRules,
  shouldSyncPath,
} from "./file-rules";

describe("shouldSyncPath", () => {
  it("always syncs markdown files outside hidden folders", () => {
    expect(shouldSyncPath("Notes/daily.md", DEFAULT_SYNC_FILE_RULES)).toBe(true);
  });

  it("excludes hidden paths and folders", () => {
    expect(shouldSyncPath(".obsidian/workspace.json", DEFAULT_SYNC_FILE_RULES)).toBe(false);
    expect(shouldSyncPath("Notes/.trash/daily.md", DEFAULT_SYNC_FILE_RULES)).toBe(false);
  });

  it("excludes Obsidian configuration files even when other files are enabled", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeOtherFiles: true,
    });

    expect(shouldSyncPath(".obsidian/app.json", rules)).toBe(false);
    expect(shouldSyncPath(".obsidian/workspace.json", rules)).toBe(false);
    expect(shouldSyncPath(".obsidian/snippets/tweaks.css", rules)).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/calendar/data.json", rules)).toBe(false);
    expect(shouldSyncPath(".git/config", rules)).toBe(false);
    expect(shouldSyncPath("Notes/.trash/daily.md", rules)).toBe(false);
  });

  it("syncs .obsidian files when includeObsidianConfig is enabled", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeObsidianConfig: true,
    });

    expect(shouldSyncPath(".obsidian/app.json", rules)).toBe(true);
    expect(shouldSyncPath(".obsidian/snippets/tweaks.css", rules)).toBe(true);
    expect(shouldSyncPath(".obsidian/plugins/calendar/data.json", rules)).toBe(true);
  });

  it("never syncs osync plugin files even when includeObsidianConfig is enabled", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeObsidianConfig: true,
    });

    expect(shouldSyncPath(".obsidian/plugins/osync/data.json", rules)).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/osync/main.js", rules)).toBe(false);
  });

  it("never syncs device-local workspace files even when includeObsidianConfig is enabled", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeObsidianConfig: true,
    });

    expect(shouldSyncPath(".obsidian/workspace.json", rules)).toBe(false);
    expect(shouldSyncPath(".obsidian/workspace-mobile.json", rules)).toBe(false);
    // sibling files like app.json should still sync
    expect(shouldSyncPath(".obsidian/app.json", rules)).toBe(true);
  });

  it("never syncs non-.obsidian hidden paths even when includeObsidianConfig is enabled", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeObsidianConfig: true,
    });

    expect(shouldSyncPath(".git/config", rules)).toBe(false);
    expect(shouldSyncPath("Notes/.trash/daily.md", rules)).toBe(false);
  });

  it("excludes paths exceeding iOS-safe limits", () => {
    const longFilename = "a".repeat(260) + ".md"; // 263 bytes
    expect(shouldSyncPath(`notes/${longFilename}`, DEFAULT_SYNC_FILE_RULES)).toBe(false);

    // A modestly long filename within limits should still sync
    expect(
      shouldSyncPath(`notes/${"a".repeat(200)}.md`, DEFAULT_SYNC_FILE_RULES),
    ).toBe(true);
  });

  it("excludes generated sync conflict copies", () => {
    expect(shouldSyncPath("Welcomed.sync-conflict-20260424-001419.md", DEFAULT_SYNC_FILE_RULES)).toBe(
      false,
    );
    expect(
      shouldSyncPath("Folder/note.sync-conflict-20260424-001419-2.md", DEFAULT_SYNC_FILE_RULES),
    ).toBe(false);
    expect(
      shouldSyncPath(
        ".obsidian/plugins/calendar/data.sync-conflict-20260424-001419.json",
        DEFAULT_SYNC_FILE_RULES,
      ),
    ).toBe(false);
  });

  it("respects attachment category toggles", () => {
    const rules = normalizeSyncFileRules({
      includeImages: false,
      includeAudio: false,
      includeVideos: false,
      includePdf: true,
      includeOtherFiles: false,
      excludedFolders: [],
    });

    expect(shouldSyncPath("Attachments/image.png", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/sound.mp3", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/movie.mp4", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/guide.pdf", rules)).toBe(true);
    expect(shouldSyncPath("Attachments/archive.zip", rules)).toBe(false);
  });

  it("respects the catch-all other file toggle", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeOtherFiles: true,
    });

    expect(shouldSyncPath("Data/archive.zip", rules)).toBe(true);
    expect(shouldSyncPath("Data/no-extension", rules)).toBe(true);
  });

  it("excludes explicitly selected folders", () => {
    const rules = normalizeSyncFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      excludedFolders: ["Archive", "Attachments/raw"],
    });

    expect(shouldSyncPath("Archive/note.md", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/raw/image.png", rules)).toBe(false);
    expect(shouldSyncPath("Attachments/kept/image.png", rules)).toBe(true);
  });
});

describe("normalizeExcludedFolders", () => {
  it("normalizes, deduplicates, and removes hidden folders", () => {
    expect(
      normalizeExcludedFolders([
        " Archive ",
        "/Archive/",
        "Attachments/raw",
        ".obsidian",
        ".git",
      ]),
    ).toEqual(["Archive", "Attachments/raw"]);
  });
});

describe("device path policy", () => {
  const longName = `notes/${"가".repeat(85)}.md`;
  const windowsOnly = {
    describeUnwritable: (path: string) => (path.includes("?") ? "Name not allowed" : null),
  };

  it("matchesSyncFileRules ignores device limits (user-configured rules only)", () => {
    expect(matchesSyncFileRules(longName, DEFAULT_SYNC_FILE_RULES)).toBe(true);
    expect(matchesSyncFileRules("notes/what?.md", DEFAULT_SYNC_FILE_RULES)).toBe(true);
    expect(
      matchesSyncFileRules("Archive/a.md", { ...DEFAULT_SYNC_FILE_RULES, excludedFolders: ["Archive"] }),
    ).toBe(false);
  });

  it("shouldSyncPath treats a device-unwritable path like an excluded one", () => {
    expect(shouldSyncPath("notes/what?.md", DEFAULT_SYNC_FILE_RULES, windowsOnly)).toBe(false);
    expect(shouldSyncPath("notes/fine.md", DEFAULT_SYNC_FILE_RULES, windowsOnly)).toBe(true);
  });

  it("shouldSyncPath still honours user rules when a device policy is given", () => {
    expect(
      shouldSyncPath("Archive/a.md", { ...DEFAULT_SYNC_FILE_RULES, excludedFolders: ["Archive"] }, windowsOnly),
    ).toBe(false);
  });

  it("shouldSyncPath without a device policy keeps the default path limits", () => {
    expect(shouldSyncPath(longName, DEFAULT_SYNC_FILE_RULES)).toBe(false);
    expect(shouldSyncPath("notes/what?.md", DEFAULT_SYNC_FILE_RULES)).toBe(true);
  });
});

describe("folder rules", () => {
  // Folders have no extension: the file-type toggles must not decide them. With
  // "other files" off (the default) every folder used to be treated as excluded, so a
  // folder emptied/deleted on one device was never removed on the others.
  it("syncs ordinary folders regardless of the file-type toggles", () => {
    const rules = { ...DEFAULT_SYNC_FILE_RULES, includeOtherFiles: false, includeImages: false };
    expect(matchesSyncFolderRules("30-Resources/문해력", rules)).toBe(true);
    expect(matchesSyncFolderRules("Notes/v1.2 drafts", rules)).toBe(true);
    expect(shouldSyncPath("30-Resources/문해력", rules, undefined, "folder")).toBe(true);
  });

  it("still treats an extension-less path as a file by default", () => {
    expect(shouldSyncPath("30-Resources/문해력", DEFAULT_SYNC_FILE_RULES)).toBe(false);
    expect(matchesSyncEntryRules("30-Resources/문해력", DEFAULT_SYNC_FILE_RULES)).toBe(false);
  });

  it("excludes folders inside excluded folders", () => {
    const rules = { ...DEFAULT_SYNC_FILE_RULES, excludedFolders: ["Archive"] };
    expect(matchesSyncFolderRules("Archive", rules)).toBe(false);
    expect(matchesSyncFolderRules("Archive/2025", rules)).toBe(false);
    expect(matchesSyncFolderRules("Archived", rules)).toBe(true);
  });

  it("excludes hidden folders unless they are the synced Obsidian config tree", () => {
    expect(matchesSyncFolderRules("Notes/.trash", DEFAULT_SYNC_FILE_RULES)).toBe(false);
    expect(matchesSyncFolderRules(".obsidian/snippets", DEFAULT_SYNC_FILE_RULES)).toBe(false);
    const withConfig = { ...DEFAULT_SYNC_FILE_RULES, includeObsidianConfig: true };
    expect(matchesSyncFolderRules(".obsidian/snippets", withConfig)).toBe(true);
    expect(matchesSyncFolderRules(".obsidian/plugins/osync", withConfig)).toBe(false);
  });

  it("matchesSyncEntryRules dispatches on the entry kind", () => {
    expect(matchesSyncEntryRules("Notes/sub", DEFAULT_SYNC_FILE_RULES, "folder")).toBe(true);
    expect(matchesSyncEntryRules("Notes/a.md", DEFAULT_SYNC_FILE_RULES, "file")).toBe(true);
    expect(matchesSyncEntryRules("Notes/a.bin", DEFAULT_SYNC_FILE_RULES, "file")).toBe(false);
  });
});
