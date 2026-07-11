import { Notice, type Plugin } from "obsidian";
import { ConflictCleanupModal } from "../settings/settings-tab/modals";
import { openResetLocalSyncConfirmModal } from "./reset-local-sync-modal";
import type { OsyncConflictCleanupResult, OsyncConflictCopy } from "./view-models";

export interface OsyncCommandController {
  getAuthStatusLabel(): string;
  getRemoteVaultStatusLabel(): string;
  hasConnectedRemoteVault(): boolean;
  beginDeviceLogin(): Promise<void>;
  signOutDevice(): Promise<void>;
  createRemoteVaultFromPrompt(): Promise<void>;
  connectRemoteVaultFromPrompt(): Promise<void>;
  disconnectRemoteVault(): Promise<void>;
  changeVaultPasswordFromPrompt(): Promise<void>;
  openVersionHistoryPane(): Promise<void>;
  openConflictResolutionPane(): Promise<void>;
  isSyncPaused(): boolean;
  toggleSyncPause(): Promise<void>;
  resetLocalSyncStateInPlace(): Promise<void>;
  purgeExcludedFoldersFromServer(): Promise<void>;
  listConflictCopies(): Promise<OsyncConflictCopy[]>;
  deleteConflictCopies(
    paths: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<OsyncConflictCleanupResult>;
}

export function registerOsyncCommands(
  plugin: Plugin,
  controller: OsyncCommandController,
): void {
  plugin.addCommand({
    id: "sign-in-on-this-device",
    name: "Sign in on this device",
    callback: async () => {
      await controller.beginDeviceLogin();
    },
  });

  plugin.addCommand({
    id: "sign-out-on-this-device",
    name: "Sign out on this device",
    callback: async () => {
      await controller.signOutDevice();
    },
  });

  plugin.addCommand({
    id: "show-auth-status",
    name: "Show auth status",
    callback: () => {
      new Notice(controller.getAuthStatusLabel());
    },
  });

  plugin.addCommand({
    id: "create-vault",
    name: "Create vault",
    callback: async () => {
      await controller.createRemoteVaultFromPrompt();
    },
  });

  plugin.addCommand({
    id: "connect-vault",
    name: "Connect vault",
    callback: async () => {
      await controller.connectRemoteVaultFromPrompt();
    },
  });

  plugin.addCommand({
    id: "disconnect-vault",
    name: "Disconnect vault",
    callback: async () => {
      await controller.disconnectRemoteVault();
    },
  });

  plugin.addCommand({
    id: "change-vault-password",
    name: "Change vault password",
    checkCallback: (checking) => {
      if (!controller.hasConnectedRemoteVault()) {
        return false;
      }
      if (!checking) {
        void controller.changeVaultPasswordFromPrompt();
      }
      return true;
    },
  });

  plugin.addCommand({
    id: "show-vault-status",
    name: "Show vault status",
    callback: () => {
      new Notice(controller.getRemoteVaultStatusLabel());
    },
  });

  plugin.addCommand({
    id: "open-version-history",
    name: "Open version history",
    callback: async () => {
      await controller.openVersionHistoryPane();
    },
  });

  plugin.addCommand({
    id: "show-sync-conflicts",
    name: "Show sync conflicts",
    callback: async () => {
      await controller.openConflictResolutionPane();
    },
  });

  plugin.addCommand({
    id: "cleanup-conflict-copies",
    name: "Clean up conflict copies",
    checkCallback: (checking) => {
      if (!controller.hasConnectedRemoteVault()) {
        return false;
      }
      if (!checking) {
        new ConflictCleanupModal(plugin.app, {
          listConflictCopies: () => controller.listConflictCopies(),
          deleteConflictCopies: (paths, onProgress) => controller.deleteConflictCopies(paths, onProgress),
        }).open();
      }
      return true;
    },
  });

  plugin.addCommand({
    id: "purge-excluded-folders-from-server",
    name: "Purge excluded folders from server",
    checkCallback: (checking) => {
      if (!controller.hasConnectedRemoteVault()) {
        return false;
      }
      if (!checking) {
        void controller.purgeExcludedFoldersFromServer();
      }
      return true;
    },
  });

  plugin.addCommand({
    id: "toggle-sync-pause",
    name: "Toggle sync pause",
    checkCallback: (checking) => {
      if (!controller.hasConnectedRemoteVault()) {
        return false;
      }
      if (!checking) {
        void controller.toggleSyncPause();
      }
      return true;
    },
  });

  plugin.addCommand({
    id: "reset-local-sync-state",
    name: "Reset local sync state",
    checkCallback: (checking) => {
      if (!controller.hasConnectedRemoteVault()) {
        return false;
      }
      if (!checking) {
        void (async () => {
          const confirmed = await openResetLocalSyncConfirmModal(plugin.app);
          if (!confirmed) return;
          await controller.resetLocalSyncStateInPlace();
        })();
      }
      return true;
    },
  });
}
