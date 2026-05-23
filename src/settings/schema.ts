import { getDefaultApiBaseUrl, normalizeApiBaseUrl } from "../config";
import {
  DEFAULT_SYNC_FILE_RULES,
  normalizeSyncFileRules,
  type SyncFileRules,
} from "../sync/core/file-rules";

export const OSYNC_SETTINGS_KEY = "settings";

export interface OsyncPluginSettings {
  apiBaseUrl: string;
  fileRules: SyncFileRules;
  syncPaused: boolean;
}

export const DEFAULT_OSYNC_PLUGIN_SETTINGS: OsyncPluginSettings = {
  apiBaseUrl: getDefaultApiBaseUrl(),
  fileRules: DEFAULT_SYNC_FILE_RULES,
  syncPaused: false,
};

export function normalizeOsyncPluginSettings(
  value: unknown,
  defaultApiBaseUrl = getDefaultApiBaseUrl(),
): OsyncPluginSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      apiBaseUrl: defaultApiBaseUrl,
      fileRules: DEFAULT_SYNC_FILE_RULES,
      syncPaused: false,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    apiBaseUrl: normalizeApiBaseUrl(record.apiBaseUrl, defaultApiBaseUrl),
    fileRules: normalizeSyncFileRules(record.fileRules),
    syncPaused: record.syncPaused === true,
  };
}
