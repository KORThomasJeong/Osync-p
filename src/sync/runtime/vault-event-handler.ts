import type { Plugin, TFile } from "obsidian";

import type { SyncAutoLoop } from "../engine/auto-sync";
import type { SyncEventRecorder } from "../engine/event-recorder";
import type { ObsidianSyncVaultAdapter } from "../vault/obsidian-vault-adapter";

export interface SyncVaultEventHandlerDeps {
  plugin: Plugin;
  vaultAdapter: ObsidianSyncVaultAdapter;
  eventRecorder: Pick<
    SyncEventRecorder,
    "recordUpsert" | "recordRename" | "recordDelete" | "recordFolderUpsert" | "recordFolderDelete" | "recordFolderRename"
  >;
  autoLoop: Pick<SyncAutoLoop, "notifyLocalChange">;
  runLocalMutationWork: <T>(work: () => Promise<T>) => Promise<T>;
  hasActiveRemoteVaultSession: () => boolean;
  onError: (error: unknown) => void;
}

export class SyncVaultEventHandler {
  constructor(private readonly deps: SyncVaultEventHandlerDeps) {}

  register(): void {
    const { plugin } = this.deps;

    plugin.registerEvent(
      plugin.app.vault.on("create", (file) => {
        const syncableFolder = this.deps.vaultAdapter.asSyncableFolder(file);
        if (syncableFolder) {
          this.run(async () => {
            const changed = await this.deps.eventRecorder.recordFolderUpsert(syncableFolder.path);
            this.notifyLocalChangeIfNeeded(changed);
          });
          return;
        }

        const syncableFile = this.deps.vaultAdapter.asSyncableFile(file);
        const path = syncableFile?.path;
        if (!syncableFile || !path) {
          return;
        }

        this.run(async () => {
          await this.recordUpsert(path, syncableFile);
        });
      }),
    );

    plugin.registerEvent(
      plugin.app.vault.on("modify", (file) => {
        const syncableFile = this.deps.vaultAdapter.asSyncableFile(file);
        const path = syncableFile?.path;
        if (!syncableFile || !path) {
          return;
        }

        this.run(async () => {
          await this.recordUpsert(path, syncableFile);
        });
      }),
    );

    plugin.registerEvent(
      plugin.app.vault.on("rename", (file, oldPath) => {
        const syncableFolder = this.deps.vaultAdapter.asSyncableFolder(file);
        if (syncableFolder) {
          const renamedFromSyncable = this.deps.vaultAdapter.isSyncablePath(oldPath);
          this.run(async () => {
            if (renamedFromSyncable) {
              const changed = await this.deps.eventRecorder.recordFolderRename(oldPath, syncableFolder.path);
              this.notifyLocalChangeIfNeeded(changed);
            } else {
              const changed = await this.deps.eventRecorder.recordFolderUpsert(syncableFolder.path);
              this.notifyLocalChangeIfNeeded(changed);
            }
          });
          return;
        }

        const syncableFile = this.deps.vaultAdapter.asSyncableFile(file);
        const nextPath = syncableFile?.path;
        const renamedFromSyncable = this.deps.vaultAdapter.isSyncablePath(oldPath);
        const renamedToSyncable = !!syncableFile && !!nextPath;
        if (!renamedFromSyncable && !renamedToSyncable) {
          return;
        }

        this.run(async () => {
          if (renamedFromSyncable && renamedToSyncable && syncableFile && nextPath) {
            const changed = await this.deps.eventRecorder.recordRename(
              oldPath,
              nextPath,
              await this.deps.vaultAdapter.readFile(syncableFile),
              syncableFile.stat,
            );
            this.notifyLocalChangeIfNeeded(changed);
            return;
          }

          if (renamedFromSyncable) {
            const changed = await this.deps.eventRecorder.recordDelete(oldPath);
            this.notifyLocalChangeIfNeeded(changed);
            return;
          }

          if (syncableFile && nextPath) {
            await this.recordUpsert(nextPath, syncableFile);
          }
        });
      }),
    );

    plugin.registerEvent(
      plugin.app.vault.on("delete", (file) => {
        const syncableFolder = this.deps.vaultAdapter.asSyncableFolder(file);
        if (syncableFolder) {
          this.run(async () => {
            const changed = await this.deps.eventRecorder.recordFolderDelete(syncableFolder.path);
            this.notifyLocalChangeIfNeeded(changed);
          });
          return;
        }

        const path = file.path;
        const syncable = this.deps.vaultAdapter.isSyncablePath(path);
        if (!syncable) {
          return;
        }

        this.run(async () => {
          const changed = await this.deps.eventRecorder.recordDelete(path);
          this.notifyLocalChangeIfNeeded(changed);
        });
      }),
    );
  }

  private async recordUpsert(path: string, file: TFile): Promise<void> {
    const changed = await this.deps.eventRecorder.recordUpsert(
      path,
      await this.deps.vaultAdapter.readFile(file),
      file.stat,
    );
    this.notifyLocalChangeIfNeeded(changed);
  }

  private run(work: () => Promise<void>): void {
    if (!this.deps.hasActiveRemoteVaultSession()) {
      return;
    }

    void this.deps.runLocalMutationWork(async () => {
      try {
        await work();
      } catch (error) {
        try {
          this.deps.onError(error);
        } catch {
          // Keep later vault events flowing even if the error reporter fails.
        }
      }
    });
  }

  private notifyLocalChangeIfNeeded(changed: boolean): void {
    if (changed) {
      this.deps.autoLoop.notifyLocalChange();
    }
  }
}
