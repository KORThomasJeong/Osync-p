import { beforeEach, describe, expect, it } from "vitest";

import {
  getExtraButtonComponents,
  getProgressBarComponents,
  getSettingDescriptions,
  getSettingNames,
  resetObsidianMocks,
} from "../test-stubs/obsidian";
import { createSettingsTab } from "./__tests__/settings-tab-helpers";

describe("OsyncSettingTab sync status", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("shows sync progress percent after sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSyncStatusLabel: () => "Sync: not ready 0%",
      getSyncPercent: () => 0,
      getSyncProgress: () => ({
        completedEntries: 0,
        totalEntries: 0,
      }),
    });

    tab.display();

    expect(getProgressBarComponents()[0]?.value).toBe(0);
  });

  it("places authentication below sync after sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      isDeviceLoginInProgress: () => false,
    });

    tab.display();

    expect(getSettingNames().slice(0, 3)).toEqual([
      "Sync",
      "Authentication",
      "Vault management",
    ]);
  });

  it("shows sync progress when entries are syncing", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSyncState: () => "syncing",
      getSyncStatusLabel: () => "Sync: syncing 37%",
      getSyncPercent: () => 37,
      getSyncProgress: () => ({
        completedEntries: 42,
        totalEntries: 113,
      }),
    });

    tab.display();

    expect(getProgressBarComponents()[0]?.value).toBe(37);
  });

  it("shows a spinner while sync is active", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSyncState: () => "syncing",
      getSyncStatusLabel: () => "Sync: syncing 37%",
    });

    tab.display();

    expect(getExtraButtonComponents()[0]).toMatchObject({
      disabled: true,
      icon: "loader-circle",
      tooltip: "Sync in progress",
    });
    expect(getExtraButtonComponents()[0]?.extraSettingsEl.classes).toContain(
      "osync-sync-spinner",
    );
  });

  it("shows a spinner while sync is reconnecting", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSyncState: () => "reconnecting",
      getSyncStatusLabel: () => "Sync: reconnecting 0%",
    });

    tab.display();

    expect(getExtraButtonComponents()).toHaveLength(1);
  });

  it("hides the sync spinner when sync is idle", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSyncState: () => "up_to_date",
      getSyncStatusLabel: () => "Sync: up to date 100%",
    });

    tab.display();

    expect(getExtraButtonComponents()).toEqual([]);
  });

  it("shows remote storage usage in the sync status when available", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => ({
        storageUsedBytes: 24_300_000,
        storageLimitBytes: 50_000_000,
      }),
    });

    tab.display();

    expect(getSettingDescriptions()[0]).toBe(
      "Sync: synced 100% - 12 / 12 - Storage: 24.3 MB / 50 MB (49%)",
    );
  });

  it("shows unlimited remote storage usage without a zero-byte limit", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => ({
        storageUsedBytes: 24_300_000,
        storageLimitBytes: 0,
      }),
    });

    tab.display();

    expect(getSettingDescriptions()[0]).toBe(
      "Sync: synced 100% - 12 / 12 - Storage: 24.3 MB",
    );
  });

  it("omits remote storage usage in the sync status before the websocket reports it", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => null,
    });

    tab.display();

    expect(getSettingDescriptions()[0]).toBe("Sync: synced 100% - 12 / 12");
  });
});
