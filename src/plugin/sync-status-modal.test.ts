import { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCreatedNotices, resetObsidianMocks } from "../test-stubs/obsidian";
import type { UserVisibleSyncState } from "../sync/runtime/user-visible-status";
import { OsyncSyncStatusModal, type OsyncSyncStatusSource } from "./sync-status-modal";

class FakeEl {
  text = "";
  disabled = false;
  iconId?: string;
  children: FakeEl[] = [];
  classes = new Set<string>();
  attrs = new Map<string, string>();
  private listeners = new Map<string, Array<() => void>>();

  constructor(public tag = "div") {}

  createEl(tag: string, options: { text?: string; cls?: string } = {}): FakeEl {
    const child = new FakeEl(tag);
    if (options.text) child.text = options.text;
    for (const cls of options.cls?.split(/\s+/).filter(Boolean) ?? []) child.classes.add(cls);
    this.children.push(child);
    return child;
  }

  createDiv(options: { text?: string; cls?: string } = {}): FakeEl {
    return this.createEl("div", options);
  }

  createSpan(options: { text?: string; cls?: string } = {}): FakeEl {
    return this.createEl("span", options);
  }

  empty(): void {
    this.children = [];
    this.text = "";
  }

  setText(value: string): void {
    this.text = value;
  }

  addClass(cls: string): void {
    this.classes.add(cls);
  }

  toggleClass(cls: string, value: boolean): void {
    if (value) this.classes.add(cls);
    else this.classes.delete(cls);
  }

  setAttr(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  click(): void {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") ?? []) listener();
  }

  all(): FakeEl[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }

  find(cls: string): FakeEl {
    const found = this.all().find((el) => el.classes.has(cls));
    if (!found) throw new Error(`no element with class ${cls}`);
    return found;
  }

  findByText(text: string): FakeEl {
    const found = this.all().find((el) => el.tag === "button" && this.textOf(el) === text);
    if (!found) throw new Error(`no button with text ${text}`);
    return found;
  }

  textOf(el: FakeEl): string {
    return [el.text, ...el.children.map((child) => this.textOf(child))].filter(Boolean).join(" ");
  }
}

interface FakeSource extends OsyncSyncStatusSource {
  state: UserVisibleSyncState;
  label: string;
  lastVerifiedAt: number | null;
  conflicts: number;
  pending: number;
  log: { at: number; kind: string; message: string }[];
  statusListeners: Set<() => void>;
  logListeners: Set<() => void>;
  checkNowImpl: () => Promise<void>;
  openConflictsCalls: number;
  fireStatus(): void;
  unwritable: { path: string; reason: string; at: number }[];
  warnings: { path: string; reason: string }[];
  issueListeners: Set<() => void>;
  retryImpl: () => Promise<void>;
  retryCalls: number;
  fireIssues(): void;
}

function createSource(): FakeSource {
  const source: FakeSource = {
    state: "up_to_date",
    label: "Sync: up to date 100%",
    lastVerifiedAt: null,
    conflicts: 2,
    pending: 4,
    log: [],
    statusListeners: new Set(),
    logListeners: new Set(),
    checkNowImpl: async () => {},
    openConflictsCalls: 0,
    getSyncState: () => source.state,
    getSyncStatusLabel: () => source.label,
    getLastVerifiedAt: () => source.lastVerifiedAt,
    getStorageStatus: () => ({ storageUsedBytes: 2_000_000, storageLimitBytes: 1_000_000_000 }),
    getPendingUploadCount: async () => source.pending,
    getConflictCount: () => source.conflicts,
    openConflicts: () => {
      source.openConflictsCalls += 1;
    },
    checkNow: () => source.checkNowImpl(),
    getActivityLog: () => source.log,
    onActivityLogChange: (listener) => {
      source.logListeners.add(listener);
      return () => source.logListeners.delete(listener);
    },
    clearActivityLog: () => {
      source.log = [];
      for (const listener of source.logListeners) listener();
    },
    onStatusChange: (listener) => {
      source.statusListeners.add(listener);
      return () => source.statusListeners.delete(listener);
    },
    fireStatus: () => {
      for (const listener of source.statusListeners) listener();
    },
    unwritable: [],
    warnings: [],
    issueListeners: new Set(),
    retryImpl: async () => {},
    retryCalls: 0,
    getUnwritablePaths: () => source.unwritable,
    getPortabilityWarnings: () => source.warnings,
    onDeviceSyncIssuesChange: (listener) => {
      source.issueListeners.add(listener);
      return () => source.issueListeners.delete(listener);
    },
    retryUnwritablePaths: () => {
      source.retryCalls += 1;
      return source.retryImpl();
    },
    fireIssues: () => {
      for (const listener of source.issueListeners) listener();
    },
  };
  return source;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function openModal(
  source: OsyncSyncStatusSource,
  options: ConstructorParameters<typeof OsyncSyncStatusModal>[2] = {},
): { modal: OsyncSyncStatusModal; root: FakeEl } {
  const modal = new OsyncSyncStatusModal(new App() as never, source, options);
  const root = new FakeEl();
  (modal as unknown as { contentEl: FakeEl }).contentEl = root;
  modal.open();
  return { modal, root };
}

describe("OsyncSyncStatusModal", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders status, last check, pending uploads, storage and conflicts", async () => {
    const source = createSource();
    source.lastVerifiedAt = 1_000_000 - 3 * 60_000;
    const { root } = openModal(source, { now: () => 1_000_000 });
    await flush();

    expect(root.find("osync-status-header-text").text).toBe("Up to date");
    expect(root.find("osync-status-header-icon").iconId).toBe("cloud-check");
    expect(root.find("osync-status-last-check").text).toBe("Last server check: 3 min ago");
    expect(root.find("osync-status-summary").text).toBe(
      "Pending uploads: 4 · Storage: 2 MB / 1 GB",
    );
    expect(root.find("osync-status-conflicts").text).toBe("Sync conflicts (2)");
    expect(root.all().some((el) => el.tag === "button" && el.text === "Pause")).toBe(false);
  });

  it("shows never when the server has not been checked", () => {
    const { root } = openModal(createSource());
    expect(root.find("osync-status-last-check").text).toBe("Last server check: never");
  });

  it("updates live on status changes and stops after close", async () => {
    const source = createSource();
    const { modal, root } = openModal(source);
    await flush();

    source.state = "syncing";
    source.label = "Sync: syncing 37%";
    source.conflicts = 5;
    source.pending = 9;
    source.fireStatus();
    await flush();

    expect(root.find("osync-status-header-text").text).toBe("Syncing… 37%");
    expect(root.find("osync-status-header-icon").iconId).toBe("refresh-cw");
    expect(root.find("osync-status-conflicts").text).toBe("Sync conflicts (5)");
    expect(root.find("osync-status-summary").text).toContain("Pending uploads: 9");

    modal.close();
    expect(source.statusListeners.size).toBe(0);
    expect(source.logListeners.size).toBe(0);
  });

  it("re-renders the relative last check time on an interval", () => {
    vi.useFakeTimers();
    let now = 10_000_000;
    const source = createSource();
    source.lastVerifiedAt = now;
    const { modal, root } = openModal(source, { now: () => now });
    expect(root.find("osync-status-last-check").text).toBe("Last server check: just now");

    now += 4 * 60_000;
    vi.advanceTimersByTime(15_000);
    expect(root.find("osync-status-last-check").text).toBe("Last server check: 4 min ago");

    modal.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disables Check now while running and re-enables after", async () => {
    const source = createSource();
    let finish: () => void = () => {};
    source.checkNowImpl = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const { root } = openModal(source);
    const button = root.find("osync-status-check");

    button.click();
    expect(button.disabled).toBe(true);
    expect(root.find("osync-status-button-icon").classes.has("osync-status-spin")).toBe(true);
    expect(root.textOf(button)).toContain("Checking…");

    finish();
    await flush();
    expect(button.disabled).toBe(false);
    expect(root.find("osync-status-button-icon").classes.has("osync-status-spin")).toBe(false);
    expect(root.textOf(button)).toContain("Check now");
  });

  it("shows a notice when Check now fails", async () => {
    const source = createSource();
    source.checkNowImpl = async () => {
      throw new Error("offline");
    };
    const { root } = openModal(source);
    root.find("osync-status-check").click();
    await flush();
    expect(getCreatedNotices()).toContain("Osync: Check failed: offline");
    expect(root.find("osync-status-check").disabled).toBe(false);
  });

  it("opens conflicts and closes the modal", () => {
    const source = createSource();
    const { root } = openModal(source);
    root.find("osync-status-conflicts").click();
    expect(source.openConflictsCalls).toBe(1);
    expect(source.statusListeners.size).toBe(0);
  });

  it("lists recent activity newest first in a collapsed section, live-updating", () => {
    const source = createSource();
    const base = new Date(2026, 0, 1, 9, 5).getTime();
    source.log = [
      { at: base, kind: "push", message: "Uploaded 2 files" },
      { at: base + 60 * 60_000, kind: "pull", message: "Downloaded 1 file" },
    ];
    const { root } = openModal(source);

    const details = root.find("osync-status-activity");
    expect(details.tag).toBe("details");
    expect(details.attrs.has("open")).toBe(false);
    expect(root.find("osync-status-activity-summary").text).toBe("Recent activity (2)");
    const rows = root.all().filter((el) => el.classes.has("osync-status-activity-row"));
    expect(rows.map((row) => root.textOf(row))).toEqual([
      "10:05 pull Downloaded 1 file",
      "09:05 push Uploaded 2 files",
    ]);

    source.log = [...source.log, { at: base + 2 * 60 * 60_000, kind: "error", message: "boom" }];
    for (const listener of source.logListeners) listener();
    expect(root.find("osync-status-activity-summary").text).toBe("Recent activity (3)");
  });

  it("copies the full log with ISO timestamps and notifies", async () => {
    const source = createSource();
    source.log = [{ at: Date.UTC(2026, 0, 1, 8, 0), kind: "push", message: "ok" }];
    const writes: string[] = [];
    const { root } = openModal(source, {
      writeClipboard: async (text) => {
        writes.push(text);
      },
    });
    root.findByText("Copy").click();
    await flush();
    expect(writes).toEqual(["2026-01-01T08:00:00.000Z push ok"]);
    expect(getCreatedNotices()).toContain("Osync: Activity log copied.");
  });

  it("notifies when copying fails", async () => {
    const { root } = openModal(createSource(), {
      writeClipboard: async () => {
        throw new Error("denied");
      },
    });
    root.findByText("Copy").click();
    await flush();
    expect(getCreatedNotices()).toContain("Osync: Could not copy activity log: denied");
  });

  describe("device sync issues", () => {
    const hasClass = (root: FakeEl, cls: string) => root.all().some((el) => el.classes.has(cls));

    it("shows no device sections when there is nothing to report", () => {
      const { root } = openModal(createSource());
      expect(hasClass(root, "osync-status-unwritable")).toBe(false);
      expect(hasClass(root, "osync-status-portability")).toBe(false);
      expect(root.find("osync-status-header-text").text).toBe("Up to date");
    });

    it("lists files not synced to this device with a Retry button, and counts them in the headline", async () => {
      const source = createSource();
      source.unwritable = [
        { path: "2026/a?.md", reason: 'Name not allowed on Windows (contains "?")', at: 1 },
      ];
      let finish: () => void = () => {};
      source.retryImpl = () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
      const { root } = openModal(source);

      expect(root.find("osync-status-header-text").text).toBe(
        "Up to date · 1 file not synced here",
      );
      expect(root.find("osync-status-header-icon").iconId).toBe("cloud-check");
      const details = root.find("osync-status-unwritable");
      expect(details.tag).toBe("details");
      expect(root.find("osync-status-unwritable-summary").text).toBe(
        "Not synced to this device (1)",
      );
      const rows = root.all().filter((el) => el.classes.has("osync-status-issue-row"));
      expect(rows.map((row) => root.textOf(row))).toEqual([
        '2026/a?.md Name not allowed on Windows (contains "?")',
      ]);

      const retry = root.find("osync-status-unwritable-retry");
      retry.click();
      expect(source.retryCalls).toBe(1);
      expect(retry.disabled).toBe(true);
      finish();
      await flush();
      expect(retry.disabled).toBe(false);
    });

    it("lists files that won't open on Windows with a rename hint", () => {
      const source = createSource();
      source.warnings = [{ path: "2026/b?.md", reason: 'contains "?"' }];
      const { root } = openModal(source);

      expect(root.find("osync-status-portability-summary").text).toBe(
        "Won't open on Windows (1)",
      );
      expect(root.find("osync-status-portability-hint").text).toContain("Rename");
      const rows = root.all().filter((el) => el.classes.has("osync-status-issue-row"));
      expect(rows.map((row) => root.textOf(row))).toEqual(['2026/b?.md contains "?"']);
      // Warnings alone do not change the headline.
      expect(root.find("osync-status-header-text").text).toBe("Up to date");
    });

    it("updates live and unsubscribes on close", () => {
      const source = createSource();
      const { modal, root } = openModal(source);
      source.unwritable = [{ path: "x.md", reason: "EBUSY", at: 1 }];
      source.fireIssues();
      expect(root.find("osync-status-unwritable-summary").text).toBe(
        "Not synced to this device (1)",
      );
      expect(root.find("osync-status-header-text").text).toBe(
        "Up to date · 1 file not synced here",
      );
      modal.close();
      expect(source.issueListeners.size).toBe(0);
    });

    it("shows a notice when Retry fails", async () => {
      const source = createSource();
      source.unwritable = [{ path: "x.md", reason: "EBUSY", at: 1 }];
      source.retryImpl = async () => {
        throw new Error("offline");
      };
      const { root } = openModal(source);
      root.find("osync-status-unwritable-retry").click();
      await flush();
      expect(getCreatedNotices()).toContain("Osync: Retry failed: offline");
    });
  });

  it("clears the activity log", () => {
    const source = createSource();
    source.log = [{ at: 1, kind: "push", message: "ok" }];
    const { root } = openModal(source);
    root.findByText("Clear").click();
    expect(source.log).toEqual([]);
    expect(root.find("osync-status-activity-summary").text).toBe("Recent activity (0)");
    expect(root.find("osync-status-activity-empty").text).toBe("No recent activity.");
  });

  describe("blocked uploads", () => {
    it("lists local changes the server kept rejecting, with a Retry that refreshes the list", async () => {
      const source = createSource();
      let blocked = [
        { path: "notes/a.md", reason: "Rejected by the server repeatedly" },
        { path: "big.zip", reason: "Too large for the server" },
      ];
      const retryBlockedUploads = vi.fn(async () => {
        blocked = [{ path: "big.zip", reason: "Too large for the server" }];
      });
      source.getBlockedUploads = async () => blocked;
      source.retryBlockedUploads = retryBlockedUploads;
      const { root } = openModal(source);
      await flush();

      expect(root.find("osync-status-blocked-summary").text).toBe(
        "Not uploaded from this device (2)",
      );
      const list = root.find("osync-status-blocked");
      expect(list.textOf(list)).toContain("notes/a.md");
      expect(list.textOf(list)).toContain("Rejected by the server repeatedly");

      root.find("osync-status-blocked-retry").click();
      await flush();

      expect(retryBlockedUploads).toHaveBeenCalledTimes(1);
      expect(root.find("osync-status-blocked-summary").text).toBe(
        "Not uploaded from this device (1)",
      );
    });

    it("shows no section when nothing is blocked", async () => {
      const source = createSource();
      source.getBlockedUploads = async () => [];
      const { root } = openModal(source);
      await flush();

      expect(() => root.find("osync-status-blocked")).toThrow();
    });
  });

  describe("vault key", () => {
    it("lists entries that can't be decrypted and opens the key check from there", async () => {
      const source = createSource();
      let unreadable = 0;
      const openVerifyVaultKey = vi.fn();
      source.getUnreadableEntryCount = () => unreadable;
      source.openVerifyVaultKey = openVerifyVaultKey;
      const { root } = openModal(source);
      await flush();

      expect(() => root.find("osync-status-unreadable")).toThrow();

      unreadable = 507;
      source.fireIssues();

      expect(root.find("osync-status-unreadable-summary").text).toBe(
        "Can't be decrypted with this vault's key (507)",
      );
      root.find("osync-status-unreadable-verify").click();
      expect(openVerifyVaultKey).toHaveBeenCalledTimes(1);
    });

    it("has a Verify vault key button in the actions row", async () => {
      const source = createSource();
      const openVerifyVaultKey = vi.fn();
      source.openVerifyVaultKey = openVerifyVaultKey;
      const { root } = openModal(source);
      await flush();

      root.find("osync-status-verify-key").click();

      expect(openVerifyVaultKey).toHaveBeenCalledTimes(1);
    });
  });
});
