import type { PluginDataStoreLike } from "../plugin-data";
import { getDefaultApiBaseUrl, parseApiBaseUrlInput } from "../config";
import {
  DEFAULT_OSYNC_PLUGIN_SETTINGS,
  normalizeOsyncPluginSettings,
  type OsyncPluginSettings,
  OSYNC_SETTINGS_KEY,
} from "./schema";
import { normalizeSyncFileRules, type SyncFileRules } from "../sync/core/file-rules";

export class OsyncSettingsStore {
  private settings: OsyncPluginSettings = DEFAULT_OSYNC_PLUGIN_SETTINGS;

  constructor(
    private readonly pluginDataStore: PluginDataStoreLike,
    private readonly defaultApiBaseUrl = getDefaultApiBaseUrl(),
  ) {}

  initialize(): OsyncPluginSettings {
    try {
      this.settings = normalizeOsyncPluginSettings(
        this.pluginDataStore.read(OSYNC_SETTINGS_KEY),
        this.defaultApiBaseUrl,
      );
    } catch (error) {
      this.settings = {
        ...DEFAULT_OSYNC_PLUGIN_SETTINGS,
        apiBaseUrl: this.defaultApiBaseUrl,
      };
      throw error;
    }

    return this.settings;
  }

  getSnapshot(): OsyncPluginSettings {
    return this.settings;
  }

  async updateApiBaseUrl(nextValue: string): Promise<boolean> {
    const normalized = parseApiBaseUrlInput(nextValue, this.defaultApiBaseUrl);
    if (normalized === this.settings.apiBaseUrl) {
      return false;
    }

    this.settings = {
      ...this.settings,
      apiBaseUrl: normalized,
    };
    this.pluginDataStore.write(OSYNC_SETTINGS_KEY, this.settings);
    await this.pluginDataStore.save();
    return true;
  }

  async updateFileRules(nextRules: SyncFileRules): Promise<boolean> {
    const normalized = normalizeSyncFileRules(nextRules);
    if (JSON.stringify(normalized) === JSON.stringify(this.settings.fileRules)) {
      return false;
    }

    this.settings = {
      ...this.settings,
      fileRules: normalized,
    };
    this.pluginDataStore.write(OSYNC_SETTINGS_KEY, this.settings);
    await this.pluginDataStore.save();
    return true;
  }

  async updateSyncPaused(paused: boolean): Promise<void> {
    this.settings = { ...this.settings, syncPaused: paused };
    this.pluginDataStore.write(OSYNC_SETTINGS_KEY, this.settings);
    await this.pluginDataStore.save();
  }
}
