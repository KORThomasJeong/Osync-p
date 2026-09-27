import type { Plugin } from "obsidian";
import { describe, expect, it } from "vitest";

import {
  formatStatusBarSyncLabel,
  formatStatusBarTooltip,
  OsyncStatusBar,
} from "./status-bar";

describe("formatStatusBarSyncLabel", () => {
  it("removes the trailing sync percent", () => {
    expect(formatStatusBarSyncLabel("Sync: syncing 37%")).toBe("Sync: syncing");
  });

  it("keeps labels without a trailing percent unchanged", () => {
    expect(formatStatusBarSyncLabel("Sync: attention needed")).toBe(
      "Sync: attention needed",
    );
  });
});

describe("formatStatusBarTooltip", () => {
  it("adds the last server check under the full status label", () => {
    const now = 10_000_000;
    expect(formatStatusBarTooltip("Sync: up to date 100%", now - 3 * 60_000, now)).toBe(
      "Sync: up to date 100%\nLast server check: 3 min ago",
    );
  });

  it("falls back to the status label when the time is not available", () => {
    expect(formatStatusBarTooltip("Sync: up to date 100%", undefined)).toBe(
      "Sync: up to date 100%",
    );
  });
});

describe("OsyncStatusBar", () => {
  function createStatusBarElement() {
    const listeners = new Map<string, () => void>();
    return {
      text: "",
      attrs: new Map<string, string>(),
      listeners,
      setText(value: string) {
        this.text = value;
      },
      setAttr(name: string, value: string) {
        this.attrs.set(name, value);
      },
      addClass() {},
      addEventListener(type: string, listener: () => void) {
        listeners.set(type, listener);
      },
    };
  }

  it("keeps the label short and puts the last server check in the tooltip", () => {
    const element = createStatusBarElement();
    const plugin = { addStatusBarItem: () => element } as unknown as Plugin;
    let lastVerifiedAt = Date.now() - 2 * 60_000;
    const statusBar = new OsyncStatusBar(plugin, {
      getSyncStatusLabel: () => "Sync: up to date 100%",
      isSyncPaused: () => false,
      getLastVerifiedAt: () => lastVerifiedAt,
    });

    statusBar.initialize();

    expect(element.text).toBe("Sync: up to date");
    expect(element.attrs.get("aria-label")).toBe(
      "Sync: up to date 100%\nLast server check: 2 min ago",
    );

    // The relative time is recomputed on hover, not frozen at the last refresh.
    lastVerifiedAt = Date.now() - 7 * 60_000;
    element.listeners.get("mouseenter")?.();
    expect(element.attrs.get("aria-label")).toBe(
      "Sync: up to date 100%\nLast server check: 7 min ago",
    );
  });
});
