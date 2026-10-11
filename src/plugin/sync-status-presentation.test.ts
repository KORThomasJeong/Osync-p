import { beforeEach, describe, expect, it } from "vitest";

import { resetObsidianMocks, setMissingIconIds } from "../test-stubs/obsidian";
import type { UserVisibleSyncState } from "../sync/runtime/user-visible-status";
import {
  formatActivityLogForCopy,
  formatLastServerCheck,
  formatPendingAndStorage,
  formatSyncStateHeadline,
  formatSyncStatusTooltip,
  getSyncStateIcon,
  resolveSyncStateIconId,
  sortActivityNewestFirst,
} from "./sync-status-presentation";

describe("sync state icon mapping", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it.each<[UserVisibleSyncState, string]>([
    ["up_to_date", "cloud-check"],
    ["syncing", "refresh-cw"],
    ["checking", "refresh-cw"],
    ["attention_needed", "alert-triangle"],
    ["reconnecting", "cloud-off"],
    ["not_ready", "cloud-off"],
  ])("maps %s to %s", (state, icon) => {
    expect(getSyncStateIcon(state).icon).toBe(icon);
    expect(resolveSyncStateIconId(state)).toBe(icon);
  });

  it("falls back to check-circle when cloud-check is not bundled", () => {
    setMissingIconIds(["cloud-check"]);
    expect(resolveSyncStateIconId("up_to_date")).toBe("check-circle");
  });

  it("accepts an injected icon lookup", () => {
    expect(resolveSyncStateIconId("up_to_date", () => false)).toBe("check-circle");
    expect(resolveSyncStateIconId("syncing", () => false)).toBe("refresh-cw");
  });
});

describe("sync status formatting", () => {
  it("renders human headlines", () => {
    expect(formatSyncStateHeadline("up_to_date")).toBe("Up to date");
    expect(formatSyncStateHeadline("checking")).toBe("Checking…");
    expect(formatSyncStateHeadline("reconnecting")).toBe("Reconnecting…");
    expect(formatSyncStateHeadline("attention_needed")).toBe("Attention needed");
    expect(formatSyncStateHeadline("not_ready")).toBe("Not ready");
    expect(formatSyncStateHeadline("syncing", "Sync: syncing 42%")).toBe("Syncing… 42%");
    expect(formatSyncStateHeadline("syncing")).toBe("Syncing…");
  });

  it("adds the not-synced-here count to the up-to-date headline only", () => {
    expect(formatSyncStateHeadline("up_to_date", "", 1)).toBe(
      "Up to date · 1 file not synced here",
    );
    expect(formatSyncStateHeadline("up_to_date", "", 3)).toBe(
      "Up to date · 3 files not synced here",
    );
    expect(formatSyncStateHeadline("up_to_date", "", 0)).toBe("Up to date");
    expect(formatSyncStateHeadline("checking", "", 2)).toBe("Checking…");
  });

  it("formats the last server check, with never for null", () => {
    const now = 50_000_000;
    expect(formatLastServerCheck(null, now)).toBe("Last server check: never");
    expect(formatLastServerCheck(now - 5 * 60_000, now)).toBe("Last server check: 5 min ago");
  });

  it("builds the ribbon tooltip from label and last check", () => {
    const now = 50_000_000;
    expect(formatSyncStatusTooltip("Sync: up to date 100%", now - 2 * 60_000, now)).toBe(
      "Sync: up to date 100%\nLast server check: 2 min ago",
    );
  });

  it("formats pending uploads and storage", () => {
    expect(
      formatPendingAndStorage(3, { storageUsedBytes: 1_500_000, storageLimitBytes: 1_000_000_000 }),
    ).toBe("Pending uploads: 3 · Storage: 1.5 MB / 1 GB");
    expect(formatPendingAndStorage(null, null)).toBe("Pending uploads: … · Storage: —");
  });

  it("sorts activity newest first and copies oldest first with ISO timestamps", () => {
    const entries = [
      { at: Date.UTC(2026, 0, 1, 10, 0), kind: "push", message: "a" },
      { at: Date.UTC(2026, 0, 1, 12, 0), kind: "pull", message: "b" },
      { at: Date.UTC(2026, 0, 1, 11, 0), kind: "error", message: "c" },
    ];
    expect(sortActivityNewestFirst(entries).map((entry) => entry.message)).toEqual(["b", "c", "a"]);
    expect(formatActivityLogForCopy(entries)).toBe(
      [
        "2026-01-01T10:00:00.000Z push a",
        "2026-01-01T11:00:00.000Z error c",
        "2026-01-01T12:00:00.000Z pull b",
      ].join("\n"),
    );
  });
});
