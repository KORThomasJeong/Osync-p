import { describe, expect, it } from "vitest";

import { formatStatusBarSyncLabel } from "./status-bar";

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
