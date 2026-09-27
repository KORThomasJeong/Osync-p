import { describe, expect, it } from "vitest";

import {
  formatLastVerifiedLabel,
  formatUserVisibleSyncState,
  getUserVisibleSyncDisplayPercent,
} from "./user-visible-status";

describe("user-visible sync status", () => {
  it("labels the checking state without claiming completion", () => {
    expect(formatUserVisibleSyncState("checking")).toBe("Sync: checking 0%");
    expect(getUserVisibleSyncDisplayPercent("checking")).toBe(0);
    expect(
      formatUserVisibleSyncState("checking", { completedEntries: 3, totalEntries: 4 }),
    ).toBe("Sync: checking 75%");
  });

  it("formats how long ago the server was last checked", () => {
    const now = 10_000_000;
    expect(formatLastVerifiedLabel(null, now)).toBe("Last server check: not yet");
    expect(formatLastVerifiedLabel(now - 20_000, now)).toBe("Last server check: just now");
    expect(formatLastVerifiedLabel(now - 5 * 60_000, now)).toBe(
      "Last server check: 5 min ago",
    );
    expect(formatLastVerifiedLabel(now - 3 * 3_600_000, now)).toBe(
      "Last server check: 3 h ago",
    );
    expect(formatLastVerifiedLabel(now - 2 * 86_400_000, now)).toBe(
      "Last server check: 2 d ago",
    );
    // Clock skew must not produce a negative age.
    expect(formatLastVerifiedLabel(now + 5_000, now)).toBe("Last server check: just now");
  });
});
