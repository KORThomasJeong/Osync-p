import { describe, expect, it } from "vitest";

import { createTestPlugin } from "../../test-support/test-plugin";
import {
  createVaultLocalUnwritablePathsStorage,
  DeviceSyncIssues,
  UNWRITABLE_PATHS_STORAGE_KEY,
  type DeviceSyncIssuesStorage,
} from "./device-sync-issues";

const WINDOWS = { isWin: true };
const MAC = { isWin: false };

function memoryStorage(initial: string | null = null): DeviceSyncIssuesStorage & {
  value: string | null;
} {
  return {
    value: initial,
    load() {
      return this.value;
    },
    save(json: string) {
      this.value = json;
    },
  };
}

describe("DeviceSyncIssues as a device path policy", () => {
  it("rejects Windows-invalid names only on Windows, and path limits everywhere", () => {
    expect(new DeviceSyncIssues({ platform: WINDOWS }).describeUnwritable("a/b?.md")).toBe(
      'Name not allowed on Windows (contains "?")',
    );
    expect(new DeviceSyncIssues({ platform: MAC }).describeUnwritable("a/b?.md")).toBeNull();
    expect(
      new DeviceSyncIssues({ platform: MAC }).describeUnwritable(`a/${"가".repeat(85)}.md`),
    ).not.toBeNull();
  });

  it("treats a path whose write failed here as unwritable until retried", () => {
    const issues = new DeviceSyncIssues({ platform: MAC, now: () => 5 });
    expect(
      issues.applyPullEvent({ kind: "write_failed", entryId: "e", path: "a/locked.md", reason: "EBUSY" }),
    ).toBe(true);
    expect(issues.describeUnwritable("a/locked.md")).toBe("EBUSY");
    expect(issues.describeUnwritable("a/other.md")).toBeNull();

    expect(issues.takeWriteFailures()).toEqual([{ entryId: "e", path: "a/locked.md" }]);
    expect(issues.describeUnwritable("a/locked.md")).toBeNull();
    expect(issues.getUnwritablePaths()).toEqual([]);
  });

  it("keeps a failed path excluded when a later pull reports it as skipped", () => {
    const issues = new DeviceSyncIssues({ platform: MAC });
    issues.applyPullEvent({ kind: "write_failed", entryId: "e", path: "a.md", reason: "EBUSY" });
    // The pull skips it precisely because it is in the failure set.
    expect(
      issues.applyPullEvent({ kind: "skipped", entryId: "e", path: "a.md", reason: "EBUSY" }),
    ).toBe(false);
    expect(issues.describeUnwritable("a.md")).toBe("EBUSY");
    expect(issues.takeWriteFailures()).toEqual([{ entryId: "e", path: "a.md" }]);
  });

  it("matches failed paths regardless of Unicode normalization", () => {
    const issues = new DeviceSyncIssues({ platform: MAC });
    issues.applyPullEvent({ kind: "write_failed", entryId: "e", path: "한글.md", reason: "x" });
    expect(issues.describeUnwritable("한글.md".normalize("NFD"))).toBe("x");
  });
});

describe("DeviceSyncIssues unwritable list", () => {
  it("lists skipped and failed entries, reports only newly seen issues, and clears resolved entries", () => {
    let now = 1;
    const issues = new DeviceSyncIssues({ platform: WINDOWS, now: () => now });
    let changes = 0;
    issues.onChange(() => {
      changes += 1;
    });

    expect(
      issues.applyPullEvent({ kind: "skipped", entryId: "a", path: "x?.md", reason: "bad name" }),
    ).toBe(true);
    now = 2;
    expect(
      issues.applyPullEvent({ kind: "skipped", entryId: "a", path: "x?.md", reason: "bad name" }),
    ).toBe(false);
    expect(
      issues.applyPullEvent({ kind: "write_failed", entryId: "b", path: "y.md", reason: "ENOENT" }),
    ).toBe(true);
    expect(issues.getUnwritablePaths()).toEqual([
      { path: "x?.md", reason: "bad name", at: 1 },
      { path: "y.md", reason: "ENOENT", at: 2 },
    ]);

    // Same entry later applied under a valid path: its record clears.
    expect(issues.applyPullEvent({ kind: "resolved", entryId: "a", path: "x.md" })).toBe(false);
    expect(issues.getUnwritablePaths().map((entry) => entry.path)).toEqual(["y.md"]);
    expect(changes).toBe(3);
  });

  it("persists across restarts and ignores corrupt storage", () => {
    const storage = memoryStorage();
    const first = new DeviceSyncIssues({ platform: MAC, storage, now: () => 7 });
    first.applyPullEvent({ kind: "write_failed", entryId: "b", path: "y.md", reason: "ENOENT" });

    const second = new DeviceSyncIssues({ platform: MAC, storage });
    expect(second.getUnwritablePaths()).toEqual([{ path: "y.md", reason: "ENOENT", at: 7 }]);
    expect(second.describeUnwritable("y.md")).toBe("ENOENT");

    expect(
      new DeviceSyncIssues({ platform: MAC, storage: memoryStorage("{not json") }).getUnwritablePaths(),
    ).toEqual([]);
    expect(
      new DeviceSyncIssues({
        platform: MAC,
        storage: memoryStorage(JSON.stringify([{ path: 1 }, "x"])),
      }).getUnwritablePaths(),
    ).toEqual([]);
  });

  it("stores under osync.unwritablePaths in the vault-local storage", () => {
    const plugin = createTestPlugin();
    const storage = createVaultLocalUnwritablePathsStorage(plugin);
    new DeviceSyncIssues({ platform: MAC, storage }).applyPullEvent({
      kind: "write_failed",
      entryId: "b",
      path: "y.md",
      reason: "ENOENT",
    });
    const app = plugin.app as unknown as { loadLocalStorage(key: string): unknown };
    expect(typeof app.loadLocalStorage(UNWRITABLE_PATHS_STORAGE_KEY)).toBe("string");
  });
});

describe("DeviceSyncIssues portability warnings", () => {
  it("warns about local paths Windows cannot open, once per path per session", () => {
    const issues = new DeviceSyncIssues({ platform: MAC });
    expect(issues.noteLocalPaths(["ok.md", "2026/a?.md"])).toEqual([
      { path: "2026/a?.md", reason: 'contains "?"', name: "a?.md" },
    ]);
    expect(issues.noteLocalPaths(["2026/a?.md"])).toEqual([]);
    expect(issues.getPortabilityWarnings()).toEqual([
      { path: "2026/a?.md", reason: 'contains "?"' },
    ]);
  });

  it("drops warnings for renamed or deleted paths, and a complete scan replaces the list", () => {
    const issues = new DeviceSyncIssues({ platform: MAC });
    issues.noteLocalPaths(["a?.md", "b*.md"]);
    issues.forgetLocalPath("a?.md");
    expect(issues.getPortabilityWarnings().map((w) => w.path)).toEqual(["b*.md"]);

    issues.noteLocalPaths(["c:d.md"], { complete: true });
    expect(issues.getPortabilityWarnings().map((w) => w.path)).toEqual(["c:d.md"]);
    // Already notified this session: renaming back does not notify again.
    expect(issues.noteLocalPaths(["b*.md"])).toEqual([]);
  });
});

describe("DeviceSyncIssues unreadable entries", () => {
  it("records each undecryptable entry once and notifies listeners", () => {
    const issues = new DeviceSyncIssues({ platform: MAC });
    let changes = 0;
    issues.onChange(() => {
      changes += 1;
    });

    expect(issues.noteUnreadableEntry("e1")).toBe(true);
    expect(issues.noteUnreadableEntry("e1")).toBe(false);
    expect(issues.noteUnreadableEntry("e2")).toBe(true);

    expect(issues.getUnreadableEntryCount()).toBe(2);
    expect(issues.getUnreadableEntryIds()).toEqual(["e1", "e2"]);
    expect(changes).toBe(2);
  });

  it("clears an entry once it decrypts, and a full scan replaces the list", () => {
    const issues = new DeviceSyncIssues({ platform: MAC });
    issues.noteUnreadableEntry("e1");
    issues.noteUnreadableEntry("e2");

    issues.forgetUnreadableEntry("e1");
    expect(issues.getUnreadableEntryIds()).toEqual(["e2"]);

    issues.replaceUnreadableEntries(["e3"]);
    expect(issues.getUnreadableEntryIds()).toEqual(["e3"]);
  });

  it("persists unreadable entries separately from unwritable paths", () => {
    const storage = memoryStorage();
    const unreadableStorage = memoryStorage();
    const first = new DeviceSyncIssues({ platform: MAC, storage, unreadableStorage });
    first.noteUnreadableEntry("e1");

    const second = new DeviceSyncIssues({ platform: MAC, storage, unreadableStorage });
    expect(second.getUnreadableEntryIds()).toEqual(["e1"]);
    expect(second.getUnwritablePaths()).toEqual([]);
    expect(
      new DeviceSyncIssues({ platform: MAC, unreadableStorage: memoryStorage("{bad") }).getUnreadableEntryCount(),
    ).toBe(0);
  });
});
