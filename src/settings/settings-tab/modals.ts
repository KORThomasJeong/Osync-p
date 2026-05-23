import { App, Modal, Notice, Setting } from "obsidian";

import type {
  OsyncConflictCleanupResult,
  OsyncConflictCopy,
  OsyncDeletedFile,
} from "../../plugin/view-models";
import { formatDeletedFileTimestamp, groupByDeletionTime } from "./format";

export class ExcludedFoldersModal extends Modal {
  private readonly selectedFolders: Set<string>;

  constructor(
    app: App,
    private readonly options: {
      availableFolders: string[];
      initialSelection: string[];
      onSubmit: (paths: string[]) => Promise<void>;
    },
  ) {
    super(app);
    this.selectedFolders = new Set(options.initialSelection);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Excluded folders" });
    contentEl.createEl("p", {
      text: "Select folders that should never sync from this device.",
    });

    if (this.options.availableFolders.length === 0) {
      contentEl.createEl("p", {
        text: "No folders are currently available to exclude.",
      });
    } else {
      for (const folder of this.options.availableFolders) {
        new Setting(contentEl)
          .setName(folder)
          .addToggle((toggle) =>
            toggle.setValue(this.selectedFolders.has(folder)).onChange((value) => {
              if (value) {
                this.selectedFolders.add(folder);
              } else {
                this.selectedFolders.delete(folder);
              }
            }),
          );
      }
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Done").setCta().onClick(() => {
          void this.options.onSubmit(
            [...this.selectedFolders].sort((a, b) => a.localeCompare(b)),
          );
          this.close();
        }),
      );
  }
}

export class DeletedFilesModal extends Modal {
  private readonly selectedEntryIds = new Set<string>();
  private deletedFiles: OsyncDeletedFile[] = [];
  private loading = false;
  private error: string | null = null;

  constructor(
    app: App,
    private readonly options: {
      listDeletedFiles: () => Promise<OsyncDeletedFile[]>;
      restoreDeletedFiles: (entryIds: string[]) => Promise<{ restored: number; failed: number }>;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    void this.loadDeletedFiles();
  }

  private async loadDeletedFiles(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();

    try {
      this.deletedFiles = await this.options.listDeletedFiles();
      for (const entryId of [...this.selectedEntryIds]) {
        if (!this.deletedFiles.some((file) => file.entryId === entryId && !file.dirty)) {
          this.selectedEntryIds.delete(entryId);
        }
      }
    } catch (error) {
      this.deletedFiles = [];
      this.selectedEntryIds.clear();
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private get selectableFiles(): OsyncDeletedFile[] {
    return this.deletedFiles.filter((f) => !f.dirty);
  }

  private toggleSelectAll(select: boolean): void {
    for (const file of this.selectableFiles) {
      if (select) {
        this.selectedEntryIds.add(file.entryId);
      } else {
        this.selectedEntryIds.delete(file.entryId);
      }
    }
    this.render();
  }

  private toggleSelectGroup(entryIds: string[], select: boolean): void {
    for (const id of entryIds) {
      if (select) {
        this.selectedEntryIds.add(id);
      } else {
        this.selectedEntryIds.delete(id);
      }
    }
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Deleted files" });

    if (this.error) {
      contentEl.createEl("p", { cls: "osync-modal-error", text: this.error });
    } else {
      contentEl.createEl("p", {
        cls: "osync-modal-hint",
        text: "Select synced deleted files to restore.",
      });
    }

    const selectedCount = this.selectedEntryIds.size;
    const selectableCount = this.selectableFiles.length;
    const allSelected = selectableCount > 0 && selectedCount === selectableCount;

    // Top action bar — always visible before the file list
    new Setting(contentEl)
      .addToggle((toggle) =>
        toggle
          .setValue(allSelected)
          .setDisabled(this.loading || selectableCount === 0)
          .onChange((value) => {
            this.toggleSelectAll(value);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(
            selectedCount > 0 ? `Restore selected (${selectedCount})` : "Restore selected",
          )
          .setCta()
          .setDisabled(this.loading || selectedCount === 0)
          .onClick(() => {
            void this.restoreSelected();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Refresh").setDisabled(this.loading).onClick(() => {
          void this.loadDeletedFiles();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Close").onClick(() => {
          this.close();
        }),
      );

    if (this.loading) {
      contentEl.createEl("p", { cls: "osync-modal-empty", text: "Loading deleted files..." });
      return;
    }

    if (!this.error && this.deletedFiles.length === 0) {
      contentEl.createEl("p", {
        cls: "osync-modal-empty",
        text: "No synced deleted files are available to restore.",
      });
      return;
    }

    for (const group of groupByDeletionTime(this.deletedFiles)) {
      const selectableInGroup = group.files.filter((f) => !f.dirty);
      const groupEntryIds = selectableInGroup.map((f) => f.entryId);
      const groupSelectedCount = groupEntryIds.filter((id) =>
        this.selectedEntryIds.has(id),
      ).length;
      const groupAllSelected =
        groupEntryIds.length > 0 && groupSelectedCount === groupEntryIds.length;

      new Setting(contentEl)
        .setName(`${group.label}  (${group.files.length})`)
        .setHeading()
        .addToggle((toggle) =>
          toggle
            .setValue(groupAllSelected)
            .setDisabled(this.loading || groupEntryIds.length === 0)
            .onChange((value) => {
              this.toggleSelectGroup(groupEntryIds, value);
            }),
        );

      for (const file of group.files) {
        new Setting(contentEl)
          .setName(file.path)
          .setDesc(file.dirty ? "Sync first" : `Deleted ${formatDeletedFileTimestamp(file.deletedAt)}`)
          .addToggle((toggle) => {
            toggle
              .setValue(this.selectedEntryIds.has(file.entryId))
              .setDisabled(file.dirty || this.loading)
              .onChange((value) => {
                if (value) {
                  this.selectedEntryIds.add(file.entryId);
                } else {
                  this.selectedEntryIds.delete(file.entryId);
                }
                this.render();
              });
          });
      }
    }
  }

  private async restoreSelected(): Promise<void> {
    const entryIds = [...this.selectedEntryIds];
    if (entryIds.length === 0) {
      return;
    }

    this.loading = true;
    this.render();

    try {
      const { restored, failed } = await this.options.restoreDeletedFiles(entryIds);
      const parts = [`${restored} restored`];
      if (failed > 0) parts.push(`${failed} failed`);
      new Notice(`Deleted file restore finished: ${parts.join(", ")}.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Restore failed.");
    }

    await this.loadDeletedFiles();
  }
}

export class UrlUpdateModal extends Modal {
  private urlInput: string;

  constructor(
    app: App,
    private readonly options: {
      errorMessage: string;
      currentUrl: string;
      onSubmit: (url: string) => Promise<void>;
    },
  ) {
    super(app);
    this.urlInput = options.currentUrl;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Sign-in failed" });
    contentEl.createEl("p", {
      cls: "osync-modal-error",
      text: `Device sign-in failed: ${this.options.errorMessage}`,
    });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Would you like to update the server URL?",
    });

    new Setting(contentEl).setName("Server URL").addText((text) =>
      text
        .setPlaceholder("https://your-server.example.com")
        .setValue(this.urlInput)
        .onChange((value) => {
          this.urlInput = value;
        }),
    );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Save URL")
          .setCta()
          .onClick(async () => {
            try {
              await this.options.onSubmit(this.urlInput);
              this.close();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
            }
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

type ConflictCleanupState = "loading" | "ready" | "deleting" | "done";

export interface ConflictCleanupModalOptions {
  listConflictCopies: () => Promise<OsyncConflictCopy[]>;
  deleteConflictCopies: (
    paths: string[],
    onProgress?: (done: number, total: number) => void,
  ) => Promise<OsyncConflictCleanupResult>;
}

export class ConflictCleanupModal extends Modal {
  private state: ConflictCleanupState = "loading";
  private files: OsyncConflictCopy[] = [];
  private error: string | null = null;
  private result: OsyncConflictCleanupResult | null = null;
  private progress = { done: 0, total: 0 };

  constructor(
    app: App,
    private readonly options: ConflictCleanupModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    void this.loadFiles();
  }

  private async loadFiles(): Promise<void> {
    this.state = "loading";
    this.error = null;
    this.render();
    try {
      this.files = await this.options.listConflictCopies();
    } catch (error) {
      this.files = [];
      this.error = error instanceof Error ? error.message : String(error);
    }
    if (!this.error && this.files.length === 0) {
      new Notice("No conflict copies found.");
      this.close();
      return;
    }
    this.state = "ready";
    this.render();
  }

  private async confirmAndDelete(): Promise<void> {
    const count = this.files.length;
    const confirmed = await openConfirmDeleteModal(this.app, count);
    if (!confirmed) return;

    this.state = "deleting";
    this.progress = { done: 0, total: count };
    this.render();

    const paths = this.files.map((f) => f.path);
    try {
      this.result = await this.options.deleteConflictCopies(paths, (done, total) => {
        this.progress = { done, total };
        this.render();
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.result = { successCount: 0, failures: [] };
    }
    this.state = "done";
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Clean up conflict copies" });

    if (this.state === "loading") {
      contentEl.createEl("p", { cls: "osync-modal-empty", text: "Scanning vault..." });
      return;
    }

    if (this.error && this.state === "ready") {
      contentEl.createEl("p", { cls: "osync-modal-error", text: this.error });
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close()),
      );
      return;
    }

    if (this.state === "ready") {
      contentEl.createEl("p", {
        cls: "osync-modal-hint",
        text: `Found ${this.files.length} conflict ${this.files.length === 1 ? "copy" : "copies"}. They will be deleted from this device; the deletion will sync to other devices.`,
      });
      const list = contentEl.createDiv({ cls: "osync-modal-file-list" });
      for (const file of this.files) {
        const row = list.createDiv({ cls: "osync-modal-file-row" });
        row.createEl("div", { cls: "osync-modal-file-path", text: file.path });
        row.createEl("div", {
          cls: "osync-modal-file-meta",
          text: `${formatBytes(file.size)} • ${formatTimestamp(file.mtime)}`,
        });
      }
      new Setting(contentEl)
        .addButton((btn) =>
          btn
            .setButtonText(`Delete all (${this.files.length})`)
            .setWarning()
            .onClick(() => void this.confirmAndDelete()),
        )
        .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
      return;
    }

    if (this.state === "deleting") {
      contentEl.createEl("p", {
        cls: "osync-modal-empty",
        text: `Deleting... (${this.progress.done}/${this.progress.total})`,
      });
      return;
    }

    if (this.state === "done") {
      const result = this.result!;
      contentEl.createEl("p", {
        cls: result.failures.length > 0 ? "osync-modal-error" : "osync-modal-hint",
        text: `Deleted ${result.successCount}. Failed ${result.failures.length}.`,
      });
      if (result.failures.length > 0) {
        contentEl.createEl("p", {
          cls: "osync-modal-hint",
          text: "Check the developer console for details.",
        });
      }
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText("Close").setCta().onClick(() => this.close()),
      );
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface StoreCorruptionModalOptions {
  resetLocalSyncState: () => Promise<void>;
}

export class StoreCorruptionModal extends Modal {
  constructor(
    app: App,
    private readonly options: StoreCorruptionModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Sync store needs recovery" });
    contentEl.createEl("p", {
      text: "Two entries on this device claim the same file path. Sync cannot proceed for affected files until the local sync state is reset.",
    });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Reset only wipes the plugin's sync database. Your vault files are not deleted; the plugin will re-pull state from the server.",
    });
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Reset local sync state")
          .setWarning()
          .onClick(async () => {
            try {
              await this.options.resetLocalSyncState();
              new Notice("Local sync state reset. Sync will restart.");
            } catch (error) {
              new Notice(
                `Reset failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            } finally {
              this.close();
            }
          }),
      )
      .addButton((btn) => btn.setButtonText("Dismiss").onClick(() => this.close()));
  }
}

function openConfirmDeleteModal(app: App, count: number): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.empty();
      contentEl.createEl("h3", { text: `Delete ${count} conflict ${count === 1 ? "copy" : "copies"}?` });
      contentEl.createEl("p", { text: "This cannot be undone. Files will be deleted from this device and the deletion will sync to other devices." });
      new Setting(contentEl)
        .addButton((btn) =>
          btn
            .setButtonText("Delete")
            .setWarning()
            .onClick(() => {
              resolve(true);
              modal.close();
            }),
        )
        .addButton((btn) =>
          btn.setButtonText("Cancel").onClick(() => {
            resolve(false);
            modal.close();
          }),
        );
    };
    modal.onClose = () => resolve(false);
    modal.open();
  });
}
