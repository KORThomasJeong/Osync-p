import { App, Plugin } from "obsidian";
import { vi } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "../../sync/core/file-rules";
import type { OsyncSettingsController } from "../controller";
import { OsyncSettingTab } from "../settings-tab";

const TestPlugin = Plugin as unknown as new () => Plugin;

export function createSettingsTab(
  overrides: Partial<OsyncSettingsController> = {},
): OsyncSettingTab {
  const controller: OsyncSettingsController = {
    getAuthStatusLabel: () => "Not signed in.",
    getSyncState: () => "not_ready",
    getSyncStatusLabel: () => "Sync: not ready 0%",
    getSyncPercent: () => 0,
    getSyncProgress: () => ({
      completedEntries: 0,
      totalEntries: 0,
    }),
    getStorageStatus: () => null,
    watchStorageStatus: vi.fn(),
    unwatchStorageStatus: vi.fn(),
    getRemoteVaultStatusLabel: () => "No vault connected.",
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    hasAuthenticatedSession: () => false,
    isDeviceLoginInProgress: () => false,
    hasConnectedRemoteVault: () => false,
    beginDeviceLogin: vi.fn(async () => {}),
    signOutDevice: vi.fn(async () => {}),
    createRemoteVaultFromPrompt: vi.fn(async () => {}),
    connectRemoteVaultFromPrompt: vi.fn(async () => {}),
    openRemoteVaultManagementPage: vi.fn(() => {}),
    disconnectRemoteVault: vi.fn(async () => {}),
    updateApiBaseUrl: vi.fn(async () => {}),
    getSyncFileRules: () => ({
      ...DEFAULT_SYNC_FILE_RULES,
      excludedFolders: [...DEFAULT_SYNC_FILE_RULES.excludedFolders],
    }),
    updateSyncFileRule: vi.fn(async () => {}),
    updateExcludedFolders: vi.fn(async () => {}),
    listSelectableExcludedFolderPaths: () => [],
    listDeletedFiles: vi.fn(async () => []),
    restoreDeletedFiles: vi.fn(async () => ({ restored: 0, failed: 0 })),
    resetLocalSyncStateInPlace: vi.fn(async () => {}),
    ...overrides,
  };

  return new OsyncSettingTab(new App(), new TestPlugin(), controller);
}

export async function nextTask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
