import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestPlugin } from "../../test-support/test-plugin";
import {
  ACTIVITY_LOG_STORAGE_KEY,
  createVaultLocalActivityLogStorage,
  SyncActivityLog,
  type SyncActivityLogStorage,
} from "./activity-log";

function createMemoryStorage(initial: string | null = null): SyncActivityLogStorage & {
  saved: string[];
} {
  let value = initial;
  const saved: string[] = [];
  return {
    saved,
    load: () => value,
    save: (json) => {
      value = json;
      saved.push(json);
    },
  };
}

describe("SyncActivityLog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records entries oldest first with timestamps", () => {
    let now = 1_000;
    const log = new SyncActivityLog({ now: () => now });

    log.record("connect", "Connected");
    now = 2_000;
    log.record("pull", "Pulled 3 entries");

    expect(log.getEntries()).toEqual([
      { at: 1_000, kind: "connect", message: "Connected" },
      { at: 2_000, kind: "pull", message: "Pulled 3 entries" },
    ]);
  });

  it("keeps only the newest entries up to the capacity", () => {
    const log = new SyncActivityLog({ capacity: 3 });

    for (let index = 0; index < 5; index += 1) {
      log.record("push", `push ${index}`);
    }

    expect(log.getEntries().map((entry) => entry.message)).toEqual([
      "push 2",
      "push 3",
      "push 4",
    ]);
  });

  it("defaults to a capacity of 200", () => {
    const log = new SyncActivityLog();
    for (let index = 0; index < 250; index += 1) {
      log.record("push", `push ${index}`);
    }
    expect(log.getEntries()).toHaveLength(200);
    expect(log.getEntries()[0]?.message).toBe("push 50");
  });

  it("notifies listeners on change and stops after unsubscribe", () => {
    const log = new SyncActivityLog();
    const listener = vi.fn();
    const unsubscribe = log.onChange(listener);

    log.record("scan", "Scan");
    expect(listener).toHaveBeenCalledTimes(1);
    log.clear();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    log.record("scan", "Scan");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("isolates a throwing listener", () => {
    const log = new SyncActivityLog();
    const good = vi.fn();
    log.onChange(() => {
      throw new Error("boom");
    });
    log.onChange(good);

    expect(() => log.record("scan", "Scan")).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("truncates overly long messages", () => {
    const log = new SyncActivityLog();
    log.record("error", "x".repeat(1_000));
    expect(log.getEntries()[0]?.message.length).toBeLessThanOrEqual(300);
  });

  it("folds consecutive repeats of the same entry into one line", () => {
    let now = 1_000;
    const log = new SyncActivityLog({ now: () => now });

    log.record("error", "Error (retrying): offline");
    now = 2_000;
    log.record("error", "Error (retrying): offline");
    now = 3_000;
    log.record("error", "Error (retrying): offline");

    expect(log.getEntries()).toEqual([
      { at: 3_000, kind: "error", message: "Error (retrying): offline (×3)" },
    ]);

    log.record("connect", "Connected");
    log.record("error", "Error (retrying): offline");
    expect(log.getEntries().map((entry) => entry.message)).toEqual([
      "Error (retrying): offline (×3)",
      "Connected",
      "Error (retrying): offline",
    ]);
  });

  describe("persistence", () => {
    it("restores entries saved by a previous app session", () => {
      const storage = createMemoryStorage();
      const first = new SyncActivityLog({ storage });
      first.record("disconnect", "Socket closed");
      first.flush();

      const second = new SyncActivityLog({ storage });
      expect(second.getEntries()).toEqual([
        expect.objectContaining({ kind: "disconnect", message: "Socket closed" }),
      ]);
    });

    it("debounces writes and saves once after the quiet period", () => {
      vi.useFakeTimers();
      const storage = createMemoryStorage();
      const log = new SyncActivityLog({ storage, saveDebounceMs: 2_000 });

      log.record("push", "one");
      log.record("push", "two");
      vi.advanceTimersByTime(1_999);
      expect(storage.saved).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(storage.saved).toHaveLength(1);
      expect(JSON.parse(storage.saved[0] ?? "[]")).toHaveLength(2);
    });

    it("flush writes pending entries immediately and cancels the debounce", () => {
      vi.useFakeTimers();
      const storage = createMemoryStorage();
      const log = new SyncActivityLog({ storage, saveDebounceMs: 2_000 });

      log.record("flush", "Flushing");
      log.flush();
      expect(storage.saved).toHaveLength(1);

      vi.advanceTimersByTime(5_000);
      expect(storage.saved).toHaveLength(1);

      log.flush();
      expect(storage.saved).toHaveLength(1);
    });

    it("clear persists the empty log", () => {
      const storage = createMemoryStorage();
      const log = new SyncActivityLog({ storage });
      log.record("push", "one");
      log.clear();
      log.flush();

      expect(new SyncActivityLog({ storage }).getEntries()).toEqual([]);
    });

    it("ignores corrupt or malformed persisted data", () => {
      expect(new SyncActivityLog({ storage: createMemoryStorage("{not json") }).getEntries()).toEqual([]);
      expect(new SyncActivityLog({ storage: createMemoryStorage('{"a":1}') }).getEntries()).toEqual([]);

      const mixed = JSON.stringify([
        { at: 1, kind: "push", message: "ok" },
        { at: "x", kind: "push", message: "bad at" },
        { at: 2, kind: "nope", message: "bad kind" },
        null,
      ]);
      expect(new SyncActivityLog({ storage: createMemoryStorage(mixed) }).getEntries()).toEqual([
        { at: 1, kind: "push", message: "ok" },
      ]);
    });

    it("survives storage that throws on load and save", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const storage: SyncActivityLogStorage = {
        load: () => {
          throw new Error("denied");
        },
        save: () => {
          throw new Error("quota");
        },
      };

      const log = new SyncActivityLog({ storage });
      expect(() => {
        log.record("push", "one");
        log.flush();
      }).not.toThrow();
      expect(log.getEntries()).toHaveLength(1);
    });

    it("stores into the plugin's vault-scoped local storage", () => {
      const plugin = createTestPlugin();
      const storage = createVaultLocalActivityLogStorage(plugin);
      const log = new SyncActivityLog({ storage });
      log.record("resume", "Resume");
      log.flush();

      const app = plugin.app as unknown as { loadLocalStorage(key: string): unknown };
      expect(typeof app.loadLocalStorage(ACTIVITY_LOG_STORAGE_KEY)).toBe("string");
      expect(new SyncActivityLog({ storage: createVaultLocalActivityLogStorage(plugin) }).getEntries()).toHaveLength(1);
    });
  });
});
