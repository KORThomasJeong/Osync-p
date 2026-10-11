import type { Plugin } from "obsidian";

import {
  describeDeviceWriteIssue,
  describeWindowsNameIssue,
  formatWindowsNameIssue,
  type DevicePathPolicy,
  type DevicePlatform,
} from "../core/path-portability";
import type { PullDeviceIssueEvent } from "../engine/pull-entry-state-applier";
import { toPathKey } from "../store/dexie/path-key";

// What this device could not sync, and which local files other devices will not be
// able to open.
//
// - Unwritable: remote entries this device skipped (a name Windows rejects, a path over
//   the limits) or failed to write (any error from the OS). Both are device-excluded
//   via describeUnwritable(), the same seam as an excluded folder: no disk I/O, no
//   upload, no delete propagated for the missing file. Persisted per vault so a restart
//   neither forgets them (the pull cursor is already past them) nor retries forever.
// - Portability warnings: local files whose names Windows cannot hold. They still
//   upload; the user is told once per path per session so they can rename them.
// - Unreadable entries: remote entries whose metadata or content this device's vault
//   key cannot decrypt (written with another vault's key). The pull quarantines them
//   and moves on, so they are persisted per vault — the cursor is already past them.
//   Persisted with the fingerprint of the key that last confirmed them unreadable: a
//   different key (the corrected one) makes every one of them worth fetching again.

export const UNWRITABLE_PATHS_STORAGE_KEY = "osync.unwritablePaths";
export const UNREADABLE_ENTRIES_STORAGE_KEY = "osync.unreadableEntries";

export interface DeviceSyncIssuesStorage {
  load(): string | null;
  save(json: string): void;
}

export interface UnwritablePathEntry {
  path: string;
  reason: string;
  at: number;
}

export interface PortabilityWarning {
  path: string;
  reason: string;
}

export interface NewPortabilityWarning extends PortabilityWarning {
  // The offending path component, for the Notice.
  name: string;
}

interface UnwritableRecord extends UnwritablePathEntry {
  entryId: string;
  kind: "skipped" | "write_failed";
}

export interface DeviceSyncIssuesOptions {
  platform: DevicePlatform;
  storage?: DeviceSyncIssuesStorage;
  // Persists the unreadable entry ids; in-memory only when omitted.
  unreadableStorage?: DeviceSyncIssuesStorage;
  now?: () => number;
}

export class DeviceSyncIssues implements DevicePathPolicy {
  // Keyed by entryId: one entry has at most one current path.
  private records = new Map<string, UnwritableRecord>();
  private warnings = new Map<string, PortabilityWarning>();
  private unreadable = new Set<string>();
  private unreadableCheckedKey: string | null = null;
  private readonly notifiedWarningKeys = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly options: DeviceSyncIssuesOptions) {
    this.now = options.now ?? (() => Date.now());
    for (const record of this.loadPersisted()) {
      this.records.set(record.entryId, record);
    }
    const persisted = this.loadPersistedUnreadable();
    this.unreadable = new Set(persisted.ids);
    this.unreadableCheckedKey = persisted.checkedWithKey;
  }

  // Returns true when the entry was not already recorded as unreadable.
  noteUnreadableEntry(entryId: string): boolean {
    if (this.unreadable.has(entryId)) {
      return false;
    }
    this.unreadable.add(entryId);
    this.unreadableChanged();
    return true;
  }

  // The entry decrypted (a later, readable revision) or was removed.
  forgetUnreadableEntry(entryId: string): void {
    if (this.unreadable.delete(entryId)) {
      this.unreadableChanged();
    }
  }

  // A full server scan is authoritative: replaces whatever pulls recorded.
  replaceUnreadableEntries(entryIds: readonly string[]): void {
    const next = new Set(entryIds);
    if (next.size === this.unreadable.size && [...next].every((id) => this.unreadable.has(id))) {
      return;
    }
    this.unreadable = next;
    this.unreadableChanged();
  }

  getUnreadableEntryCount(): number {
    return this.unreadable.size;
  }

  getUnreadableEntryIds(): string[] {
    return [...this.unreadable].sort();
  }

  // Fingerprint of the vault key the recorded entries were last re-checked with
  // (null: never). Re-checking with that same key cannot change the outcome.
  getUnreadableCheckedKey(): string | null {
    return this.unreadableCheckedKey;
  }

  setUnreadableCheckedKey(fingerprint: string | null): void {
    if (this.unreadableCheckedKey === fingerprint) {
      return;
    }
    this.unreadableCheckedKey = fingerprint;
    this.unreadableChanged();
  }

  describeUnwritable(path: string): string | null {
    const staticIssue = describeDeviceWriteIssue(path, this.options.platform);
    if (staticIssue) {
      return staticIssue;
    }

    const key = toPathKey(path);
    for (const record of this.records.values()) {
      if (record.kind === "write_failed" && toPathKey(record.path) === key) {
        return record.reason;
      }
    }
    return null;
  }

  // Returns true when the event records an issue that was not already known.
  applyPullEvent(event: PullDeviceIssueEvent): boolean {
    const existing = this.records.get(event.entryId);
    if (event.kind === "resolved") {
      if (existing) {
        this.records.delete(event.entryId);
        this.changed();
      }
      return false;
    }

    if (
      existing &&
      existing.kind === event.kind &&
      existing.path === event.path &&
      existing.reason === event.reason
    ) {
      return false;
    }
    if (
      existing?.kind === "write_failed" &&
      event.kind === "skipped" &&
      toPathKey(existing.path) === toPathKey(event.path)
    ) {
      // Skipped *because* it is in the failure set: keep it a retryable failure.
      return false;
    }

    this.records.set(event.entryId, {
      entryId: event.entryId,
      kind: event.kind,
      path: event.path,
      reason: event.reason,
      at: this.now(),
    });
    this.changed();
    return true;
  }

  getUnwritablePaths(): readonly UnwritablePathEntry[] {
    return [...this.records.values()]
      .map(({ path, reason, at }) => ({ path, reason, at }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  // Clears every runtime write failure (so the paths count as writable again) and
  // returns them for the caller to re-apply.
  takeWriteFailures(): Array<{ entryId: string; path: string }> {
    const taken: Array<{ entryId: string; path: string }> = [];
    for (const record of [...this.records.values()]) {
      if (record.kind === "write_failed") {
        taken.push({ entryId: record.entryId, path: record.path });
        this.records.delete(record.entryId);
      }
    }
    if (taken.length > 0) {
      this.changed();
    }
    return taken;
  }

  // Records local paths that Windows cannot open. Returns the warnings not yet
  // notified this session. `complete` means `paths` is a full scan: warnings for
  // paths no longer present are dropped.
  noteLocalPaths(
    paths: readonly string[],
    options: { complete?: boolean } = {},
  ): NewPortabilityWarning[] {
    const next = options.complete ? new Map<string, PortabilityWarning>() : new Map(this.warnings);
    const fresh: NewPortabilityWarning[] = [];
    for (const path of paths) {
      const issue = describeWindowsNameIssue(path);
      if (!issue) {
        continue;
      }
      const key = toPathKey(path);
      const reason = formatWindowsNameIssue(issue);
      next.set(key, { path, reason });
      if (!this.notifiedWarningKeys.has(key)) {
        this.notifiedWarningKeys.add(key);
        fresh.push({ path, reason, name: issue.component });
      }
    }

    if (!sameWarnings(this.warnings, next)) {
      this.warnings = next;
      this.changed();
    }
    return fresh;
  }

  forgetLocalPath(path: string): void {
    if (this.warnings.delete(toPathKey(path))) {
      this.changed();
    }
  }

  getPortabilityWarnings(): readonly PortabilityWarning[] {
    return [...this.warnings.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.persist();
    this.notifyListeners();
  }

  private unreadableChanged(): void {
    const storage = this.options.unreadableStorage;
    if (storage) {
      try {
        const ids = [...this.unreadable];
        // Plain id list unless a checked key is recorded (the format older versions read).
        storage.save(
          JSON.stringify(
            this.unreadableCheckedKey === null
              ? ids
              : { ids, checkedWithKey: this.unreadableCheckedKey },
          ),
        );
      } catch (error) {
        console.warn("[osync] failed to persist unreadable entries", error);
      }
    }
    this.notifyListeners();
  }

  private loadPersistedUnreadable(): { ids: string[]; checkedWithKey: string | null } {
    const empty = { ids: [], checkedWithKey: null };
    const storage = this.options.unreadableStorage;
    if (!storage) {
      return empty;
    }
    try {
      const raw = storage.load();
      if (!raw) {
        return empty;
      }
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { ids: onlyStrings(parsed), checkedWithKey: null };
      }
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        return {
          ids: Array.isArray(record.ids) ? onlyStrings(record.ids) : [],
          checkedWithKey:
            typeof record.checkedWithKey === "string" ? record.checkedWithKey : null,
        };
      }
      return empty;
    } catch (error) {
      console.warn("[osync] failed to load unreadable entries", error);
      return empty;
    }
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[osync] device sync issues listener failed", error);
      }
    }
  }

  private persist(): void {
    const storage = this.options.storage;
    if (!storage) {
      return;
    }
    try {
      storage.save(JSON.stringify([...this.records.values()]));
    } catch (error) {
      console.warn("[osync] failed to persist unwritable paths", error);
    }
  }

  private loadPersisted(): UnwritableRecord[] {
    const storage = this.options.storage;
    if (!storage) {
      return [];
    }
    try {
      const raw = storage.load();
      if (!raw) {
        return [];
      }
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isUnwritableRecord) : [];
    } catch (error) {
      console.warn("[osync] failed to load unwritable paths", error);
      return [];
    }
  }
}

// Production storage: Obsidian's vault-scoped localStorage (not synced, per device).
export function createVaultLocalUnwritablePathsStorage(
  plugin: Plugin,
  key = UNWRITABLE_PATHS_STORAGE_KEY,
): DeviceSyncIssuesStorage {
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

function sameWarnings(
  left: ReadonlyMap<string, PortabilityWarning>,
  right: ReadonlyMap<string, PortabilityWarning>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    const other = right.get(key);
    if (!other || other.path !== value.path || other.reason !== value.reason) {
      return false;
    }
  }
  return true;
}

function onlyStrings(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function isUnwritableRecord(value: unknown): value is UnwritableRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.entryId === "string" &&
    typeof record.path === "string" &&
    typeof record.reason === "string" &&
    typeof record.at === "number" &&
    (record.kind === "skipped" || record.kind === "write_failed")
  );
}
