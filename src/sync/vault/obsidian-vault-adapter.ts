import { TFolder } from "obsidian";
import type { Plugin, TAbstractFile, TFile } from "obsidian";

import type { SyncFileRules } from "../core/file-rules";
import { asSyncableFile, asSyncableFolder, isSyncableVaultPath, toArrayBuffer } from "./vault-files";

export interface SyncVaultFile {
  path: string;
  mtime: number;
  size: number;
  readBytes(): Promise<Uint8Array>;
}

export class ObsidianSyncVaultAdapter {
  constructor(
    private readonly plugin: Plugin,
    private readonly getSyncFileRules: () => SyncFileRules,
  ) {}

  asSyncableFile(file: TAbstractFile): TFile | null {
    return asSyncableFile(file, this.getSyncFileRules());
  }

  asSyncableFolder(file: TAbstractFile): TFolder | null {
    return asSyncableFolder(file, this.getSyncFileRules());
  }

  async isFolderEmpty(path: string): Promise<boolean> {
    const folder = this.plugin.app.vault.getAbstractFileByPath(path);
    return !(folder instanceof TFolder) || folder.children.length === 0;
  }

  listFolders(): string[] {
    return this.plugin.app.vault
      .getAllLoadedFiles()
      .filter(
        (f): f is TFolder =>
          f instanceof TFolder && f.path !== "/" && isSyncableVaultPath(f.path, this.getSyncFileRules()),
      )
      .map((f) => f.path);
  }

  isSyncablePath(path: string): boolean {
    return isSyncableVaultPath(path, this.getSyncFileRules());
  }

  async listFiles(): Promise<SyncVaultFile[]> {
    const files = this.plugin.app.vault
      .getFiles()
      .filter((file) => this.isSyncablePath(file.path));

    const result: SyncVaultFile[] = files.map((file) => ({
      path: file.path,
      mtime: file.stat.mtime,
      size: file.stat.size,
      readBytes: async () => await this.readFile(file),
    }));

    // vault.getFiles() does not return .obsidian files; scan them via the adapter
    if (this.getSyncFileRules().includeObsidianConfig) {
      const knownPaths = new Set(result.map((f) => f.path));
      for (const file of await this.listObsidianConfigFiles()) {
        if (!knownPaths.has(file.path)) {
          result.push(file);
        }
      }
    }

    return result;
  }

  private async listObsidianConfigFiles(): Promise<SyncVaultFile[]> {
    const result: SyncVaultFile[] = [];
    const queue = [".obsidian"];

    while (queue.length > 0) {
      const dir = queue.shift()!;
      let listed: { files: string[]; folders: string[] };
      try {
        listed = await this.plugin.app.vault.adapter.list(dir);
      } catch {
        continue;
      }

      for (const folder of listed.folders) {
        queue.push(folder);
      }

      for (const path of listed.files) {
        if (!this.isSyncablePath(path)) continue;
        const stat = await this.plugin.app.vault.adapter.stat(path);
        if (!stat) continue;
        result.push({
          path,
          mtime: stat.mtime,
          size: stat.size,
          readBytes: async () => await this.readBytes(path),
        });
      }
    }

    return result;
  }

  async readFile(file: TFile): Promise<Uint8Array> {
    return new Uint8Array(await this.plugin.app.vault.readBinary(file));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(path));
  }

  async exists(path: string): Promise<boolean> {
    return await this.plugin.app.vault.adapter.exists(path);
  }

  async mkdir(path: string): Promise<void> {
    await this.plugin.app.vault.adapter.mkdir(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.plugin.app.vault.adapter.write(path, content);
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    await this.plugin.app.vault.adapter.writeBinary(path, toArrayBuffer(content));
  }

  async remove(path: string): Promise<void> {
    await this.plugin.app.vault.adapter.remove(path);
  }
}
