import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";

import type {
  ConflictQueueItem,
  ConflictQueueSource,
} from "../sync/runtime/conflict-queue";

export const OSYNC_CONFLICT_VIEW_TYPE = "osync-conflict-resolution";

export class OsyncConflictResolutionView extends ItemView {
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly source: ConflictQueueSource,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return OSYNC_CONFLICT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Osync sync conflicts";
  }

  getIcon(): string {
    return "alert-circle";
  }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.source.onChange(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("osync-conflict-view");

    const header = root.createDiv({ cls: "osync-conflict-header" });
    header.createEl("h4", { text: "Sync conflicts", cls: "osync-conflict-title" });
    const items = this.source.list();

    if (items.length === 0) {
      root.createEl("p", {
        text: "No pending sync conflicts.",
        cls: "osync-conflict-muted",
      });
      return;
    }

    const clearAll = header.createEl("button", {
      text: "Dismiss all",
      cls: "osync-conflict-dismiss-all",
    });
    clearAll.addEventListener("click", () => {
      this.source.clear();
    });

    for (const item of items) {
      this.renderRow(root, item);
    }
  }

  private renderRow(parent: HTMLElement, item: ConflictQueueItem): void {
    const row = parent.createDiv({ cls: "osync-conflict-row" });
    const meta = row.createDiv({ cls: "osync-conflict-meta" });
    meta.createEl("strong", { text: item.originalPath });
    meta.createEl("span", {
      text: ` — ${describeReason(item.reason)}`,
      cls: "osync-conflict-reason",
    });
    if (item.conflictPath) {
      meta.createEl("div", {
        text: `Backup: ${item.conflictPath}`,
        cls: "osync-conflict-backup",
      });
    }

    const actions = row.createDiv({ cls: "osync-conflict-actions" });

    const openOriginal = actions.createEl("button", { text: "Open original" });
    openOriginal.addEventListener("click", () => {
      void this.openPath(item.originalPath);
    });

    if (item.conflictPath) {
      const openBackup = actions.createEl("button", { text: "Open backup" });
      openBackup.addEventListener("click", () => {
        void this.openPath(item.conflictPath!);
      });
    }

    const dismiss = actions.createEl("button", { text: "Dismiss" });
    dismiss.addEventListener("click", () => {
      this.source.dismiss(item.id);
    });
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      new Notice(`File not found: ${path}`);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }
}

function describeReason(reason: string): string {
  switch (reason) {
    case "remote_path_collision":
      return "remote saved to backup; local kept";
    case "remote_path_collision_client_wins":
      return "remote saved to backup; local kept (client won timestamp)";
    case "local_pending_mutation":
      return "local saved to backup; remote applied";
    case "local_pending_mutation_wins":
      return "remote saved to backup; local kept (client won timestamp)";
    default:
      return reason;
  }
}
