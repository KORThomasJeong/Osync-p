import { App, Notice, Setting } from "obsidian";

import { getDefaultApiBaseUrl } from "../../config";
import type { OsyncFileRules } from "../../plugin/view-models";
import type { OsyncAuthFacade } from "../auth-facade";
import type { OsyncSyncFacade } from "../sync-facade";
import type { OsyncVaultFacade } from "../vault-facade";
import { formatSyncDescription, shouldShowSyncSpinner } from "./format";
import { openResetLocalSyncConfirmModal } from "../../plugin/reset-local-sync-modal";
import { ConflictCleanupModal, DeletedFilesModal, ExcludedFoldersModal } from "./modals";

type RefreshSettings = () => void;

export function renderApiBaseUrlSetting(
  containerEl: HTMLElement,
  controller: OsyncAuthFacade,
  options: {
    canChangeApiBaseUrl: boolean;
    hasConnectedRemoteVault: boolean;
    isDeviceLoginInProgress: boolean;
  },
): void {
  const apiBaseUrl = controller.getApiBaseUrl();
  const visibleApiBaseUrl = apiBaseUrl === getDefaultApiBaseUrl() ? "" : apiBaseUrl;
  let apiBaseUrlInput = visibleApiBaseUrl;
  new Setting(containerEl)
    .setName("Server URL")
    .setDesc(
      options.isDeviceLoginInProgress
        ? "Finish or cancel sign-in before changing servers."
        : !options.canChangeApiBaseUrl
          ? "Sign out before changing the server URL."
          : !apiBaseUrl
            ? "Enter your server URL to get started."
            : "Enter the URL of your self-hosted server.",
    )
    .addText((text) =>
      text
        .setPlaceholder("Osync Cloud")
        .setValue(visibleApiBaseUrl)
        .setDisabled(!options.canChangeApiBaseUrl)
        .onChange((value) => {
          apiBaseUrlInput = value;
        }),
    )
    .addButton((button) =>
      button
        .setButtonText("Save")
        .setDisabled(!options.canChangeApiBaseUrl)
        .onClick(async () => {
          try {
            await controller.updateApiBaseUrl(apiBaseUrlInput);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(message);
          }
        }),
    );
}

export function renderSyncStatusSetting(
  containerEl: HTMLElement,
  controller: OsyncSyncFacade,
): void {
  const syncProgress = controller.getSyncProgress();
  const syncSetting = new Setting(containerEl)
    .setName("Sync")
    .setDesc(formatSyncDescription(
      controller.getSyncStatusLabel(),
      syncProgress,
      controller.getStorageStatus(),
    ));
  if (shouldShowSyncSpinner(controller.getSyncState())) {
    syncSetting.addExtraButton((button) => {
      button
        .setIcon("loader-circle")
        .setTooltip("Sync in progress")
        .setDisabled(true);
      button.extraSettingsEl.addClass("osync-sync-spinner");
    });
  }
  syncSetting.addProgressBar((progressBar) => {
    progressBar.setValue(controller.getSyncPercent());
  });
}

export function renderAuthenticationSetting(
  containerEl: HTMLElement,
  controller: OsyncAuthFacade,
  isDeviceLoginInProgress: boolean,
  refresh: RefreshSettings,
): void {
  const authSetting = new Setting(containerEl)
    .setName("Authentication")
    .setDesc(controller.getAuthStatusLabel());

  if (!controller.hasAuthenticatedSession()) {
    authSetting.addButton((button) =>
      button
        .setButtonText(
          isDeviceLoginInProgress
            ? "Open sign-in page again"
            : "Sign in on this device",
        )
        .onClick(async () => {
          await controller.beginDeviceLogin();
          refresh();
        }),
    );
  } else {
    authSetting.addButton((button) =>
      button
        .setButtonText("Sign out")
        .onClick(async () => {
          await controller.signOutDevice();
          refresh();
        }),
    );
  }
}

export function renderRemoteVaultSettings(
  app: App,
  containerEl: HTMLElement,
  controller: OsyncVaultFacade &
    Pick<
      OsyncSyncFacade,
      | "listDeletedFiles"
      | "restoreDeletedFiles"
      | "resetLocalSyncStateInPlace"
      | "listConflictCopies"
      | "deleteConflictCopies"
      | "purgeExcludedFoldersFromServer"
    >,
  hasConnectedRemoteVault: boolean,
  refresh: RefreshSettings,
): void {
  new Setting(containerEl)
    .setName("Vault management")
    .setDesc("Manage remote vaults for your account.")
    .addButton((button) =>
      button.setButtonText("Manage remote vaults").onClick(() => {
        controller.openRemoteVaultManagementPage();
      }),
    );

  const vaultSetting = new Setting(containerEl)
    .setName("Vault")
    .setDesc(controller.getRemoteVaultStatusLabel());

  if (hasConnectedRemoteVault) {
    vaultSetting
      .addButton((button) =>
        button.setButtonText("Change password").onClick(async () => {
          await controller.changeVaultPasswordFromPrompt();
          refresh();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Disconnect vault").onClick(async () => {
          await controller.disconnectRemoteVault();
          refresh();
        }),
      );

    new Setting(containerEl)
      .setName("Reset local sync state")
      .setDesc(
        "Clears this device's local sync cache and re-syncs from the server. " +
        "Vault connection and your files on disk are preserved. " +
        "Use when sync is stuck or behaving incorrectly.",
      )
      .addButton((button) =>
        button
          .setButtonText("Reset")
          .onClick(async () => {
            const confirmed = await openResetLocalSyncConfirmModal(app);
            if (!confirmed) return;
            await controller.resetLocalSyncStateInPlace();
            refresh();
          }),
      );

    new Setting(containerEl)
      .setName("Deleted files")
      .setDesc("Review synced files that were deleted from this vault.")
      .addButton((button) =>
        button.setButtonText("View deleted files").onClick(() => {
          new DeletedFilesModal(app, {
            listDeletedFiles: async () => await controller.listDeletedFiles(),
            restoreDeletedFiles: async (entryIds) => {
              const result = await controller.restoreDeletedFiles(entryIds);
              refresh();
              return result;
            },
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName("Sync conflict copies")
      .setDesc("Find and remove .sync-conflict-* backup files from this vault.")
      .addButton((button) =>
        button.setButtonText("Clean up conflict copies").onClick(() => {
          new ConflictCleanupModal(app, {
            listConflictCopies: () => controller.listConflictCopies(),
            deleteConflictCopies: (paths, onProgress) => controller.deleteConflictCopies(paths, onProgress),
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName("Purge excluded folders from server")
      .setDesc(
        "Remove files still on the server that this device's excluded folders no longer sync " +
          "(e.g. after excluding a folder and deleting it locally). Local files are not touched.",
      )
      .addButton((button) =>
        button.setButtonText("Purge from server").onClick(async () => {
          await controller.purgeExcludedFoldersFromServer();
          refresh();
        }),
      );
    return;
  }

  vaultSetting
    .addButton((button) =>
      button.setButtonText("Create vault").onClick(async () => {
        await controller.createRemoteVaultFromPrompt();
        refresh();
      }),
    )
    .addButton((button) =>
      button.setButtonText("Connect vault").onClick(async () => {
        await controller.connectRemoteVaultFromPrompt();
        refresh();
      }),
    );
}

export function renderFileSyncSettings(
  app: App,
  containerEl: HTMLElement,
  controller: OsyncSyncFacade,
  refresh: RefreshSettings,
): void {
  const fileRules = controller.getSyncFileRules();

  new Setting(containerEl).setName("File sync").setHeading();

  addFileRuleToggle(
    containerEl,
    "Images",
    "Sync image attachments on this device.",
    fileRules,
    "includeImages",
    controller,
    refresh,
  );
  addFileRuleToggle(
    containerEl,
    "Audio",
    "Sync audio attachments on this device.",
    fileRules,
    "includeAudio",
    controller,
    refresh,
  );
  addFileRuleToggle(
    containerEl,
    "Videos",
    "Sync video attachments on this device.",
    fileRules,
    "includeVideos",
    controller,
    refresh,
  );
  addFileRuleToggle(
    containerEl,
    "PDF",
    "Sync PDF attachments on this device.",
    fileRules,
    "includePdf",
    controller,
    refresh,
  );
  addFileRuleToggle(
    containerEl,
    "Other file types",
    "Sync additional non-markdown file types on this device.",
    fileRules,
    "includeOtherFiles",
    controller,
    refresh,
  );

  addFileRuleToggle(
    containerEl,
    "Obsidian config",
    "Sync .obsidian config files (plugins, snippets, themes) on this device. The Osync plugin's own data is always excluded.",
    fileRules,
    "includeObsidianConfig",
    controller,
    refresh,
  );

  new Setting(containerEl)
    .setName("Excluded folders")
    .setDesc(
      fileRules.excludedFolders.length > 0
        ? `${fileRules.excludedFolders.length} folder${fileRules.excludedFolders.length === 1 ? "" : "s"} excluded on this device.`
        : "No excluded folders on this device.",
    )
    .addButton((button) =>
      button.setButtonText("Manage").onClick(() => {
        new ExcludedFoldersModal(app, {
          availableFolders: controller.listSelectableExcludedFolderPaths(),
          initialSelection: fileRules.excludedFolders,
          onSubmit: async (paths) => {
            await controller.updateExcludedFolders(paths);
            refresh();
          },
        }).open();
      }),
    );

  for (const folder of fileRules.excludedFolders) {
    new Setting(containerEl)
      .setName(folder)
      .setDesc("Excluded from sync on this device.")
      .addButton((button) =>
        button.setButtonText("Remove").onClick(async () => {
          await controller.updateExcludedFolders(
            fileRules.excludedFolders.filter((value) => value !== folder),
          );
          refresh();
        }),
      );
  }

  containerEl.createEl("p", {
    cls: "osync-setting-hint",
    text:
      "File sync rules apply only to this device. Files already uploaded to the server are not removed automatically when you exclude them here.",
  });
}

export function renderThanksSetting(containerEl: HTMLElement): void {
  const setting = new Setting(containerEl).setName("Osync");
  setting.descEl.appendText("Osync — end-to-end encrypted self-hosted sync for Obsidian.");
}

function addFileRuleToggle<K extends keyof OsyncFileRules>(
  containerEl: HTMLElement,
  name: string,
  description: string,
  fileRules: OsyncFileRules,
  key: K,
  controller: Pick<OsyncSyncFacade, "updateSyncFileRule">,
  refresh: RefreshSettings,
): void {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addToggle((toggle) =>
      toggle.setValue(fileRules[key] as boolean).onChange(async (value) => {
        await controller.updateSyncFileRule(key, value as OsyncFileRules[K]);
        refresh();
      }),
    );
}
