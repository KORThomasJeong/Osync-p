import { TAbstractFile, TFile, TFolder } from "obsidian";

import type { SyncEntryKind, SyncFileRules } from "../core/file-rules";
import { normalizeVaultPath, shouldSyncPath } from "../core/file-rules";
import type { DevicePathPolicy } from "../core/path-portability";

export function asSyncableFile(
  file: TAbstractFile,
  rules: SyncFileRules,
  device?: DevicePathPolicy,
): TFile | null {
  return file instanceof TFile && isSyncableVaultPath(file.path, rules, device) ? file : null;
}

export function asSyncableFolder(
  file: TAbstractFile,
  rules: SyncFileRules,
  device?: DevicePathPolicy,
): TFolder | null {
  return file instanceof TFolder && isSyncableVaultPath(file.path, rules, device, "folder")
    ? file
    : null;
}

export function isSyncableVaultPath(
  path: string,
  rules: SyncFileRules,
  device?: DevicePathPolicy,
  kind: SyncEntryKind = "file",
): boolean {
  const normalized = normalizeVaultPath(path);
  return !!normalized && shouldSyncPath(normalized, rules, device, kind);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
