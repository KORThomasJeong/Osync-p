import type { Plugin, TFile } from "obsidian";

import type { SyncAutoLoop } from "../engine/auto-sync";
import { DeleteBurstDetector } from "../engine/delete-burst-detector";
import type { SyncEventRecorder } from "../engine/event-recorder";
import type { ObsidianSyncVaultAdapter } from "../vault/obsidian-vault-adapter";

const DEFAULT_DELETE_BURST_WINDOW_MS = 10_000;
const DEFAULT_DELETE_BURST_THRESHOLD = 50;

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
  // Fired when a burst of live deletes crosses the threshold — a script/tool deleting many
  // files while Obsidian is open, which the reconcile-only mass-delete guard never sees.
  onDeleteBurst?: () => void;
  now?: () => number;
  deleteBurst?: { windowMs: number; threshold: number };
}

export class SyncVaultEventHandler {
  private readonly deleteBurstDetector: DeleteBurstDetector;
  private deleteBurstNotified = false;

  constructor(private readonly deps: SyncVaultEventHandlerDeps) {
    this.deleteBurstDetector = new DeleteBurstDetector({
      windowMs: deps.deleteBurst?.windowMs ?? DEFAULT_DELETE_BURST_WINDOW_MS,
      threshold: deps.deleteBurst?.threshold ?? DEFAULT_DELETE_BURST_THRESHOLD,
    });
  }

  private noteDelete(): void {
    const now = this.deps.now?.() ?? Date.now();
    if (this.deleteBurstDetector.record(now)) {
      if (!this.deleteBurstNotified) {
        this.deleteBurstNotified = true;
        this.deps.onDeleteBurst?.();
      }
    }
  }

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
          if (changed) {
            this.noteDelete();
          }
        });
      }),
    );
  }

  // Re-record a path whose event was dropped while it was suppressed during a pull's
  // write window. Reads the current disk state: an existing file/folder becomes an
  // upsert, a vanished path becomes a delete — so a user edit or delete that landed
  // mid-pull is not lost until the next full reconcile.
  replayPath(path: string): void {
    this.run(async () => {
      const file = this.deps.plugin.app.vault.getAbstractFileByPath(path);
      if (!file) {
        if (this.deps.vaultAdapter.isSyncablePath(path)) {
          const changed = await this.deps.eventRecorder.recordDelete(path);
          this.notifyLocalChangeIfNeeded(changed);
        }
        return;
      }

      const syncableFolder = this.deps.vaultAdapter.asSyncableFolder(file);
      if (syncableFolder) {
        const changed = await this.deps.eventRecorder.recordFolderUpsert(syncableFolder.path);
        this.notifyLocalChangeIfNeeded(changed);
        return;
      }

      const syncableFile = this.deps.vaultAdapter.asSyncableFile(file);
      if (syncableFile) {
        await this.recordUpsert(syncableFile.path, syncableFile);
      }
    });
  }

  private async recordUpsert(path: string, file: TFile): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.vaultAdapter.readFile(file);
    } catch (error) {
      // The file was removed between the vault event and this deferred read — common with
      // atomic saves (write temp → rename → delete) and build scripts. This is benign: a
      // delete event follows for the real target, so don't raise an alarming error status.
      console.warn(
        `[osync] skipping upsert for ${path}: file no longer readable (likely removed)`,
        error,
      );
      return;
    }
    const changed = await this.deps.eventRecorder.recordUpsert(path, bytes, file.stat);
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
