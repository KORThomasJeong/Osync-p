import { Plugin } from "obsidian";

import { registerOsyncCommands } from "./plugin/commands";
import {
  OSYNC_CONFLICT_VIEW_TYPE,
  OsyncConflictResolutionView,
} from "./plugin/conflict-resolution-view";
import { OsyncPluginController } from "./plugin/plugin-controller";
import { OsyncStatusBar } from "./plugin/status-bar";
import {
  OSYNC_VERSION_HISTORY_VIEW_TYPE,
  OsyncVersionHistoryView,
} from "./plugin/version-history-view";
import { OsyncSettingTab } from "./settings/settings-tab";

export default class OsyncPlugin extends Plugin {
  private controller: OsyncPluginController | null = null;
  private statusBar: OsyncStatusBar | null = null;
  private settingsTab: OsyncSettingTab | null = null;

  async onload(): Promise<void> {
    const controller = new OsyncPluginController({
      plugin: this,
      refreshUi: () => {
        this.refreshUi();
      },
    });
    this.controller = controller;

    await controller.initialize();

    this.statusBar = new OsyncStatusBar(this, controller, () => {
      void controller.toggleSyncPause();
    });
    this.statusBar.initialize();

    this.registerView(
      OSYNC_VERSION_HISTORY_VIEW_TYPE,
      (leaf) => new OsyncVersionHistoryView(leaf, controller),
    );
    this.registerView(
      OSYNC_CONFLICT_VIEW_TYPE,
      (leaf) => new OsyncConflictResolutionView(leaf, controller.getConflictQueue()),
    );
    this.settingsTab = new OsyncSettingTab(this.app, this, controller);
    this.addSettingTab(this.settingsTab);
    registerOsyncCommands(this, controller);
    this.registerConnectivityEvents(controller);

    this.refreshUi();

    this.app.workspace.onLayoutReady(() => {
      controller.registerVaultEvents();
      controller.initializeFileExplorerMarker();
      this.registerEvent(
        this.app.vault.on("create", () => controller.notifyFileExplorerMarkerChanged()),
      );
      this.registerEvent(
        this.app.vault.on("modify", () => controller.notifyFileExplorerMarkerChanged()),
      );
      this.registerEvent(
        this.app.vault.on("delete", () => controller.notifyFileExplorerMarkerChanged()),
      );
      void controller.ensureAutoSyncState();
    });
  }

  onunload(): void {
    this.controller?.unloadFileExplorerMarker();
    void this.controller?.stop();
  }

  private registerConnectivityEvents(controller: OsyncPluginController): void {
    const resume = () => {
      controller.queueAutoSyncResume();
    };

    this.registerDomEvent(window, "online", resume);
    this.registerDomEvent(window, "focus", resume);
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (activeDocument.visibilityState === "visible") {
        resume();
      }
    });
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        controller.refreshVersionHistoryViews();
      }),
    );
  }

  private refreshUi(): void {
    this.settingsTab?.refresh();
    this.statusBar?.refresh();
  }
}
