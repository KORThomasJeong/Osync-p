import { describe, expect, it, vi } from "vitest";

import { UserVisibleSyncStatusTracker } from "./user-visible-status-tracker";

describe("UserVisibleSyncStatusTracker", () => {
  it("only fires onChange when the status actually transitions", () => {
    const onChange = vi.fn();
    const tracker = new UserVisibleSyncStatusTracker(onChange);

    // Initial state is "not_ready" — setting it again should not fire.
    tracker.setStatus("not_ready");
    expect(onChange).not.toHaveBeenCalled();

    tracker.setStatus("syncing");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(tracker.getState()).toBe("syncing");

    // Same value again — no extra fire.
    tracker.setStatus("syncing");
    expect(onChange).toHaveBeenCalledTimes(1);

    tracker.setStatus("up_to_date");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(tracker.getDisplayPercent()).toBe(100);
    expect(tracker.getStatusLabel()).toBe("Sync: up to date 100%");
  });

  it("normalizes negative or zero-total progress and ignores no-op updates", () => {
    const onChange = vi.fn();
    const tracker = new UserVisibleSyncStatusTracker(onChange);

    // Null progress is ignored entirely.
    tracker.setProgress(null);
    expect(onChange).not.toHaveBeenCalled();
    expect(tracker.getProgress()).toEqual({
      completedEntries: 0,
      totalEntries: 0,
    });

    // totalEntries === 0 collapses to {0,0} which equals the initial value -> no change.
    tracker.setProgress({ completedEntries: 5, totalEntries: 0 });
    expect(onChange).not.toHaveBeenCalled();

    // Negative completed gets clamped to 0; this is still {0, 4} which differs.
    tracker.setProgress({ completedEntries: -3, totalEntries: 4 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(tracker.getProgress()).toEqual({
      completedEntries: 0,
      totalEntries: 4,
    });

    // Same normalized result -> no extra fire.
    tracker.setProgress({ completedEntries: -1, totalEntries: 4 });
    expect(onChange).toHaveBeenCalledTimes(1);

    tracker.setProgress({ completedEntries: 2, totalEntries: 4 });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(tracker.getDisplayPercent()).toBe(50);
  });

  it("diffs storage status by used and limit bytes only", () => {
    const onChange = vi.fn();
    const tracker = new UserVisibleSyncStatusTracker(onChange);

    // null -> null, no change.
    tracker.setStorageStatus(null);
    expect(onChange).not.toHaveBeenCalled();

    tracker.setStorageStatus({ storageUsedBytes: 100, storageLimitBytes: 1000 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(tracker.getStorageStatus()).toEqual({
      storageUsedBytes: 100,
      storageLimitBytes: 1000,
    });

    // Identical values -> no fire.
    tracker.setStorageStatus({ storageUsedBytes: 100, storageLimitBytes: 1000 });
    expect(onChange).toHaveBeenCalledTimes(1);

    // Used bytes differ -> fire.
    tracker.setStorageStatus({ storageUsedBytes: 200, storageLimitBytes: 1000 });
    expect(onChange).toHaveBeenCalledTimes(2);

    // Reset to null -> fire because used differs from undefined.
    tracker.setStorageStatus(null);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(tracker.getStorageStatus()).toBeNull();
  });

  it("formats labels using the current status and progress", () => {
    const tracker = new UserVisibleSyncStatusTracker(() => {});

    expect(tracker.getStatusLabel()).toBe("Sync: not ready 0%");

    tracker.setStatus("syncing");
    tracker.setProgress({ completedEntries: 1, totalEntries: 4 });
    expect(tracker.getStatusLabel()).toBe("Sync: syncing 25%");
    expect(tracker.getDisplayPercent()).toBe(25);
  });
});
