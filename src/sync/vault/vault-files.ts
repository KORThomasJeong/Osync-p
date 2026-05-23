import { TAbstractFile, TFile, TFolder } from "obsidian";

import type { SyncFileRules } from "../core/file-rules";
import { normalizeVaultPath, shouldSyncPath } from "../core/file-rules";

export function asSyncableFile(
  file: TAbstractFile,
  rules: SyncFileRules,
): TFile | null {
  return file instanceof TFile && isSyncableVaultPath(file.path, rules) ? file : null;
}

export function asSyncableFolder(
  file: TAbstractFile,
  rules: SyncFileRules,
): TFolder | null {
  return file instanceof TFolder && isSyncableVaultPath(file.path, rules) ? file : null;
}

export function isSyncableVaultPath(path: string, rules: SyncFileRules): boolean {
  const normalized = normalizeVaultPath(path);
  return !!normalized && shouldSyncPath(normalized, rules);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
