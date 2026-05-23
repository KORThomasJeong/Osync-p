import { App } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getButtonComponents,
  getCreatedElementTexts,
  resetObsidianMocks,
} from "../test-stubs/obsidian";
import { openResetLocalSyncConfirmModal } from "./reset-local-sync-modal";

describe("reset local sync confirmation modal", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("explains what is kept and what is lost", () => {
    void openResetLocalSyncConfirmModal(new App());

    const texts = getCreatedElementTexts();
    expect(texts).toContain("Reset local sync state?");
    expect(texts).toContain("Vault connection and password: kept");
    expect(texts).toContain("Files in this vault folder: kept");
  });

  it("renders Cancel and Reset buttons", () => {
    void openResetLocalSyncConfirmModal(new App());

    expect(getButtonComponents().map((button) => button.text)).toEqual([
      "Cancel",
      "Reset",
    ]);
  });

  it("resolves false when the user clicks Cancel and true when the user clicks Reset", async () => {
    const canceled = openResetLocalSyncConfirmModal(new App());
    await getButtonComponents().find((button) => button.text === "Cancel")?.click();
    await expect(canceled).resolves.toBe(false);

    resetObsidianMocks();

    const confirmed = openResetLocalSyncConfirmModal(new App());
    await getButtonComponents().find((button) => button.text === "Reset")?.click();
    await expect(confirmed).resolves.toBe(true);
  });
});
