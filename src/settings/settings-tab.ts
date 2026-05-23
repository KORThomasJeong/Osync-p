import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

import type { OsyncSettingsController } from "./controller";
import {
  renderApiBaseUrlSetting,
  renderAuthenticationSetting,
  renderFileSyncSettings,
  renderRemoteVaultSettings,
  renderSyncStatusSetting,
  renderThanksSetting,
} from "./settings-tab/sections";

export class OsyncSettingTab extends PluginSettingTab {
  private isVisible = false;
  private isWatchingStorageStatus = false;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly controller: OsyncSettingsController,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.isVisible = true;
    this.render();
  }

  refresh(): void {
    if (!this.isVisible) {
      return;
    }

    this.render();
  }

  hide(): void {
    this.isVisible = false;
    this.setStorageStatusWatching(false);
    super.hide();
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();
    const hasConnectedRemoteVault = this.controller.hasConnectedRemoteVault();
    const hasAuthenticatedSession = this.controller.hasAuthenticatedSession();
    const isDeviceLoginInProgress = this.controller.isDeviceLoginInProgress();
    const hasApiBaseUrl = !!this.controller.getApiBaseUrl();
    // Allow URL change when: not authenticated (stale vault credentials are auto-cleared on save),
    // or authenticated but no URL set yet. Block only when actively logged in with an existing URL,
    // or when device login is in progress.
    const canChangeApiBaseUrl =
      !isDeviceLoginInProgress &&
      (!hasAuthenticatedSession || !hasApiBaseUrl) &&
      !(hasAuthenticatedSession && hasConnectedRemoteVault);
    this.setStorageStatusWatching(hasAuthenticatedSession && hasConnectedRemoteVault);

    if (hasAuthenticatedSession) {
      renderSyncStatusSetting(containerEl, this.controller);
    } else {
      new Setting(containerEl).setName("Account").setHeading();
    }

    renderAuthenticationSetting(
      containerEl,
      this.controller,
      isDeviceLoginInProgress,
      () => this.refresh(),
    );

    if (hasAuthenticatedSession) {
      renderRemoteVaultSettings(
        this.app,
        containerEl,
        this.controller,
        hasConnectedRemoteVault,
        () => this.refresh(),
      );
      renderFileSyncSettings(this.app, containerEl, this.controller, () => this.refresh());
    }

    new Setting(containerEl).setName("Self-hosted server").setHeading();
    renderApiBaseUrlSetting(containerEl, this.controller, {
      canChangeApiBaseUrl,
      hasConnectedRemoteVault,
      isDeviceLoginInProgress,
    });
    renderThanksSetting(containerEl);
  }

  private setStorageStatusWatching(enabled: boolean): void {
    if (this.isWatchingStorageStatus === enabled) {
      return;
    }

    this.isWatchingStorageStatus = enabled;
    if (enabled) {
      this.controller.watchStorageStatus();
    } else {
      this.controller.unwatchStorageStatus();
    }
  }

}
