import { isPathWithinSyncLimits } from "./path-limits";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "heic",
  "bmp",
  "ico",
]);

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "flac", "ogg", "aac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
export const SYNC_CONFLICT_FILE_PATTERN =
  /\.sync-conflict-\d{8}-\d{6}(?:-\d+)?(?:\.[^/.]+)?$/;

export interface SyncFileRules {
  includeImages: boolean;
  includeAudio: boolean;
  includeVideos: boolean;
  includePdf: boolean;
  includeOtherFiles: boolean;
  includeObsidianConfig: boolean;
  excludedFolders: string[];
}

export const DEFAULT_SYNC_FILE_RULES: SyncFileRules = {
  includeImages: true,
  includeAudio: true,
  includeVideos: true,
  includePdf: true,
  includeOtherFiles: false,
  includeObsidianConfig: false,
  excludedFolders: [],
};

const OSYNC_PLUGIN_PATH = ".obsidian/plugins/osync";

const OBSIDIAN_DEVICE_LOCAL_FILES = new Set([
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
]);

export function normalizeSyncFileRules(value: unknown): SyncFileRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ...DEFAULT_SYNC_FILE_RULES,
      excludedFolders: [...DEFAULT_SYNC_FILE_RULES.excludedFolders],
    };
  }

  const record = value as Record<string, unknown>;
  return {
    includeImages: asBoolean(record.includeImages, DEFAULT_SYNC_FILE_RULES.includeImages),
    includeAudio: asBoolean(record.includeAudio, DEFAULT_SYNC_FILE_RULES.includeAudio),
    includeVideos: asBoolean(record.includeVideos, DEFAULT_SYNC_FILE_RULES.includeVideos),
    includePdf: asBoolean(record.includePdf, DEFAULT_SYNC_FILE_RULES.includePdf),
    includeOtherFiles: asBoolean(
      record.includeOtherFiles,
      DEFAULT_SYNC_FILE_RULES.includeOtherFiles,
    ),
    includeObsidianConfig: asBoolean(
      record.includeObsidianConfig,
      DEFAULT_SYNC_FILE_RULES.includeObsidianConfig,
    ),
    excludedFolders: normalizeExcludedFolders(record.excludedFolders),
  };
}

export function shouldSyncPath(path: string, rules: SyncFileRules): boolean {
  const normalizedPath = normalizeVaultPath(path);
  if (!normalizedPath) {
    return false;
  }

  if (isSyncConflictFile(normalizedPath)) {
    return false;
  }

  if (!isPathWithinSyncLimits(normalizedPath)) {
    return false;
  }

  if (isExcludedByFolder(normalizedPath, rules.excludedFolders)) {
    return false;
  }

  if (hasHiddenSegment(normalizedPath)) {
    if (!rules.includeObsidianConfig) {
      return false;
    }
    if (!isObsidianConfigPath(normalizedPath)) {
      return false;
    }
    if (isOsyncPluginPath(normalizedPath)) {
      return false;
    }
    if (isObsidianDeviceLocalFile(normalizedPath)) {
      return false;
    }
    return true;
  }

  const extension = getExtension(normalizedPath);
  if (extension === "md") {
    return true;
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return rules.includeImages;
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return rules.includeAudio;
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return rules.includeVideos;
  }

  if (PDF_EXTENSIONS.has(extension)) {
    return rules.includePdf;
  }

  return rules.includeOtherFiles;
}

export function normalizeExcludedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const normalized = normalizeVaultPath(entry);
    if (!normalized || hasHiddenSegment(normalized)) {
      continue;
    }

    seen.add(normalized);
  }

  return [...seen].sort((left, right) => left.localeCompare(right));
}

export function normalizeVaultPath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function isExcludedByFolder(path: string, excludedFolders: ReadonlyArray<string>): boolean {
  return excludedFolders.some(
    (folder) => path === folder || path.startsWith(`${folder}/`),
  );
}

function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

function isObsidianConfigPath(path: string): boolean {
  return path === ".obsidian" || path.startsWith(".obsidian/");
}

function isOsyncPluginPath(path: string): boolean {
  return path === OSYNC_PLUGIN_PATH || path.startsWith(`${OSYNC_PLUGIN_PATH}/`);
}

function isObsidianDeviceLocalFile(path: string): boolean {
  return OBSIDIAN_DEVICE_LOCAL_FILES.has(path);
}

function isSyncConflictFile(path: string): boolean {
  const parts = path.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return SYNC_CONFLICT_FILE_PATTERN.test(basename);
}

function getExtension(path: string): string {
  const parts = path.split("/");
  const basename = parts[parts.length - 1] ?? "";
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }

  return basename.slice(dotIndex + 1).toLowerCase();
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
