import type { Plugin } from "obsidian";

// A short, persisted trail of what sync did and when, so "it said up to date but my
// note never arrived" can be diagnosed after the fact. It is persisted because the
// usual recovery on mobile is restarting the app, which would erase an in-memory log
// together with the evidence. Entries carry no file contents.

export type SyncActivityKind =
  | "connect"
  | "disconnect"
  | "resume"
  | "verify"
  | "pull"
  | "push"
  | "conflict"
  | "error"
  | "flush"
  | "scan"
  | "skip"
  | "warning";

export interface SyncActivityEntry {
  at: number;
  kind: SyncActivityKind;
  message: string;
}

export type SyncActivityRecorder = (kind: SyncActivityKind, message: string) => void;

export interface SyncActivityLogStorage {
  load(): string | null;
  save(json: string): void;
}

export interface SyncActivityLogOptions {
  storage?: SyncActivityLogStorage;
  capacity?: number;
  saveDebounceMs?: number;
  now?: () => number;
}

export const ACTIVITY_LOG_STORAGE_KEY = "osync.activityLog";
const DEFAULT_CAPACITY = 200;
const DEFAULT_SAVE_DEBOUNCE_MS = 2_000;
const MAX_MESSAGE_LENGTH = 300;
const ACTIVITY_KINDS: ReadonlySet<string> = new Set<SyncActivityKind>([
  "connect",
  "disconnect",
  "resume",
  "verify",
  "pull",
  "push",
  "conflict",
  "error",
  "flush",
  "scan",
  "skip",
  "warning",
]);

export class SyncActivityLog {
  private entries: SyncActivityEntry[];
  private readonly listeners = new Set<() => void>();
  private readonly capacity: number;
  private readonly saveDebounceMs: number;
  private readonly now: () => number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  // The last recorded entry before repeat folding, so an hour offline reads as one
  // "Error … (×120)" line instead of evicting everything else from the buffer.
  private lastRecorded: { kind: SyncActivityKind; message: string; count: number } | null =
    null;

  constructor(private readonly options: SyncActivityLogOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
    this.now = options.now ?? (() => Date.now());
    this.entries = this.loadPersisted();
  }

  record(kind: SyncActivityKind, message: string): void {
    const text = truncate(message);
    const last = this.lastRecorded;
    if (last && last.kind === kind && last.message === text && this.entries.length > 0) {
      last.count += 1;
      this.entries[this.entries.length - 1] = {
        at: this.now(),
        kind,
        message: `${text} (×${last.count})`,
      };
      this.changed();
      return;
    }
    this.lastRecorded = { kind, message: text, count: 1 };
    this.entries.push({ at: this.now(), kind, message: text });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.changed();
  }

  // Oldest first, newest last.
  getEntries(): readonly SyncActivityEntry[] {
    return this.entries;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.entries = [];
    this.lastRecorded = null;
    this.changed();
  }

  // Write any unsaved entries now (app hidden / unload).
  flush(): void {
    this.clearSaveTimer();
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    const storage = this.options.storage;
    if (!storage) {
      return;
    }
    try {
      storage.save(JSON.stringify(this.entries));
    } catch (error) {
      console.warn("[osync] failed to persist sync activity log", error);
    }
  }

  private changed(): void {
    // Copy-on-write so a snapshot handed to the UI never mutates under it.
    this.entries = [...this.entries];
    this.dirty = true;
    this.scheduleSave();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[osync] sync activity log listener failed", error);
      }
    }
  }

  private scheduleSave(): void {
    if (!this.options.storage || this.saveTimer !== null) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDebounceMs);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer === null) {
      return;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private loadPersisted(): SyncActivityEntry[] {
    const storage = this.options.storage;
    if (!storage) {
      return [];
    }
    let raw: string | null;
    try {
      raw = storage.load();
    } catch (error) {
      console.warn("[osync] failed to load sync activity log", error);
      return [];
    }
    if (!raw) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isActivityEntry).slice(-this.capacity);
  }
}

// Production storage: Obsidian's vault-scoped localStorage (not synced, survives
// restarts, separate per vault).
export function createVaultLocalActivityLogStorage(
  plugin: Plugin,
  key = ACTIVITY_LOG_STORAGE_KEY,
): SyncActivityLogStorage {
  const app = plugin.app as unknown as {
    loadLocalStorage(key: string): unknown;
    saveLocalStorage(key: string, data: unknown): void;
  };
  return {
    load: () => {
      const value = app.loadLocalStorage(key);
      return typeof value === "string" ? value : null;
    },
    save: (json) => {
      app.saveLocalStorage(key, json);
    },
  };
}

// Keep log lines short and single-purpose.
export function describeActivityError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message.replace(/\s+/g, " ").trim(), 160);
}

function truncate(message: string, max = MAX_MESSAGE_LENGTH): string {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}

function isActivityEntry(value: unknown): value is SyncActivityEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.at === "number" &&
    Number.isFinite(entry.at) &&
    typeof entry.kind === "string" &&
    ACTIVITY_KINDS.has(entry.kind) &&
    typeof entry.message === "string"
  );
}
