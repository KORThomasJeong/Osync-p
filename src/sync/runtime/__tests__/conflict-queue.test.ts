import { describe, expect, it, vi } from "vitest";

import { SyncConflictQueue } from "../conflict-queue";

describe("SyncConflictQueue", () => {
  it("enqueues conflicts and notifies listeners", () => {
    const queue = new SyncConflictQueue();
    const listener = vi.fn();
    queue.onChange(listener);

    queue.enqueue({
      entryId: "e1",
      op: "upsert",
      reason: "remote_path_collision",
      originalPath: "a.md",
      conflictPath: "a.sync-conflict.md",
    });

    expect(queue.list()).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("dismiss removes a single item and emits", () => {
    const queue = new SyncConflictQueue();
    const item = queue.enqueue({
      entryId: "e1",
      op: "upsert",
      reason: "local_pending_mutation",
      originalPath: "a.md",
      conflictPath: null,
    });
    queue.enqueue({
      entryId: "e2",
      op: "upsert",
      reason: "local_pending_mutation",
      originalPath: "b.md",
      conflictPath: null,
    });
    const listener = vi.fn();
    queue.onChange(listener);

    queue.dismiss(item.id);

    expect(queue.count()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clear removes all items", () => {
    const queue = new SyncConflictQueue();
    queue.enqueue({
      entryId: "e1",
      op: "upsert",
      reason: "x",
      originalPath: "a.md",
      conflictPath: null,
    });
    queue.enqueue({
      entryId: "e2",
      op: "upsert",
      reason: "x",
      originalPath: "b.md",
      conflictPath: null,
    });
    queue.clear();
    expect(queue.count()).toBe(0);
  });

  it("onChange returns an unsubscribe function", () => {
    const queue = new SyncConflictQueue();
    const listener = vi.fn();
    const unsubscribe = queue.onChange(listener);

    queue.enqueue({
      entryId: "e1",
      op: "upsert",
      reason: "x",
      originalPath: "a.md",
      conflictPath: null,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    queue.enqueue({
      entryId: "e2",
      op: "upsert",
      reason: "x",
      originalPath: "b.md",
      conflictPath: null,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("orders list by recency (newest first)", () => {
    const queue = new SyncConflictQueue();
    queue.enqueue({
      entryId: "old",
      op: "upsert",
      reason: "x",
      originalPath: "old.md",
      conflictPath: null,
    });
    queue.enqueue({
      entryId: "new",
      op: "upsert",
      reason: "x",
      originalPath: "new.md",
      conflictPath: null,
    });
    const list = queue.list();
    expect(list[0]?.entryId).toBe("new");
    expect(list[1]?.entryId).toBe("old");
  });
});
