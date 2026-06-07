import { App, ItemView, Modal, Notice, type WorkspaceLeaf } from "obsidian";

import type {
  OsyncEntryVersion,
  OsyncEntryVersionCursor,
  OsyncEntryVersionsPage,
} from "./view-models";

export const OSYNC_VERSION_HISTORY_VIEW_TYPE = "osync-version-history";
const HISTORY_PAGE_SIZE = 25;
const PREVIEW_MAX_LINES = 500;

export type VersionHistoryViewState =
  | {
      status: "not_connected" | "no_active_file" | "not_syncable" | "not_synced";
      path?: string;
      message: string;
    }
  | ({
      status: "ready";
    } & OsyncEntryVersionsPage);

export interface VersionHistoryViewController {
  listActiveFileVersions(
    before: OsyncEntryVersionCursor | null,
    limit: number,
  ): Promise<VersionHistoryViewState>;
  restoreActiveFileVersion(versionId: string): Promise<void>;
  previewActiveFileVersion(versionId: string): Promise<string | null>;
}

class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly onResult: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("p", { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const confirm = buttons.createEl("button", {
      text: this.confirmLabel,
      cls: "mod-cta",
    });
    confirm.addEventListener("click", () => {
      this.confirmed = true;
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.onResult(this.confirmed);
  }
}

export class OsyncVersionHistoryView extends ItemView {
  private requestId = 0;
  private loading = false;
  private state: VersionHistoryViewState | null = null;
  private versions: OsyncEntryVersion[] = [];
  private nextBefore: OsyncEntryVersionCursor | null = null;
  private expandedVersionId: string | null = null;
  private previewCache = new Map<string, string | null>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly controller: VersionHistoryViewController,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return OSYNC_VERSION_HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Osync version history";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.versions = [];
    this.nextBefore = null;
    this.expandedVersionId = null;
    this.previewCache.clear();
    await this.loadPage(null);
  }

  private async loadPage(before: OsyncEntryVersionCursor | null): Promise<void> {
    const requestId = ++this.requestId;
    this.loading = true;
    this.render();

    try {
      const state = await this.controller.listActiveFileVersions(
        before,
        HISTORY_PAGE_SIZE,
      );
      if (requestId !== this.requestId) {
        return;
      }

      this.state = state;
      if (state.status === "ready") {
        this.versions = before ? [...this.versions, ...state.versions] : state.versions;
        this.nextBefore = state.nextBefore;
      } else {
        this.versions = [];
        this.nextBefore = null;
      }
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.state = {
        status: "not_connected",
        message: error instanceof Error ? error.message : String(error),
      };
      this.versions = [];
      this.nextBefore = null;
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("osync-history-view");

    root.createEl("h4", { text: "Version history", cls: "osync-history-title" });

    if (this.loading && !this.state) {
      root.createEl("p", {
        text: "Loading history...",
        cls: "osync-history-muted",
      });
      return;
    }

    if (!this.state) {
      root.createEl("p", {
        text: "Open a synced file to view its history.",
        cls: "osync-history-muted",
      });
      return;
    }

    if (this.state.status !== "ready") {
      if (this.state.path) {
        root.createEl("div", {
          text: this.state.path,
          cls: "osync-history-path",
        });
      }
      root.createEl("p", {
        text: this.state.message,
        cls: "osync-history-muted",
      });
      this.renderRefreshButton(root);
      return;
    }

    root.createEl("div", {
      text: this.state.path,
      cls: "osync-history-path",
    });
    if (this.state.dirty) {
      root.createEl("p", {
        text: "Sync local changes before restoring.",
        cls: "osync-history-warning",
      });
    }

    if (this.versions.length === 0) {
      root.createEl("p", {
        text: this.loading ? "Loading history..." : "No version history for this file.",
        cls: "osync-history-muted",
      });
      this.renderRefreshButton(root);
      return;
    }

    const list = root.createDiv({ cls: "osync-history-list" });
    for (const version of this.versions) {
      this.renderVersionRow(list, version, this.state.dirty);
    }

    const actions = root.createDiv({ cls: "osync-history-actions" });
    if (this.nextBefore) {
      const more = actions.createEl("button", {
        text: this.loading ? "Loading..." : "Load more",
        cls: "mod-cta",
      });
      more.disabled = this.loading;
      more.addEventListener("click", () => {
        void this.loadPage(this.nextBefore);
      });
    }
    this.renderRefreshButton(actions);
  }

  private renderVersionRow(
    container: HTMLElement,
    version: OsyncEntryVersion,
    restoreDisabled: boolean,
  ): void {
    const row = container.createDiv({ cls: "osync-history-row" });
    const isExpanded = this.expandedVersionId === version.versionId;

    const header = row.createDiv({ cls: "osync-history-row-header" });
    const main = header.createDiv({ cls: "osync-history-row-main" });
    main.createEl("div", {
      text: formatCapturedAt(version.capturedAt),
      cls: "osync-history-row-title",
    });
    main.createEl("div", {
      text: formatReason(version.reason),
      cls: "osync-history-row-meta",
    });

    header.addEventListener("click", () => {
      this.expandedVersionId = isExpanded ? null : version.versionId;
      this.render();
    });
    header.addClass("osync-clickable");

    if (isExpanded) {
      this.renderPreviewArea(row, version, restoreDisabled);
    }
  }

  private renderPreviewArea(
    row: HTMLElement,
    version: OsyncEntryVersion,
    restoreDisabled: boolean,
  ): void {
    const area = row.createDiv({ cls: "osync-history-preview-area" });
    const cached = this.previewCache.get(version.versionId);

    if (cached === undefined) {
      area.createEl("p", { text: "Loading preview...", cls: "osync-history-muted" });
      void this.fetchPreview(version.versionId);
    } else if (cached === "loading") {
      area.createEl("p", { text: "Loading preview...", cls: "osync-history-muted" });
    } else if (cached === null) {
      area.createEl("p", { text: "Preview not available", cls: "osync-history-muted" });
    } else {
      const lines = cached.split("\n");
      const truncated = lines.length > PREVIEW_MAX_LINES;
      const displayText = truncated
        ? lines.slice(0, PREVIEW_MAX_LINES).join("\n") + "\n— truncated —"
        : cached;
      area.createEl("pre", {
        text: displayText,
        cls: "osync-history-preview-text",
      });
    }

    const button = area.createEl("button", {
      text: restoreDisabled ? "Sync first" : "Restore",
      cls: "osync-history-restore",
    });
    button.disabled = restoreDisabled || this.loading;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.restoreVersion(version);
    });
  }

  private async fetchPreview(versionId: string): Promise<void> {
    if (this.previewCache.has(versionId)) {
      return;
    }
    this.previewCache.set(versionId, "loading");
    this.render();
    try {
      const content = await this.controller.previewActiveFileVersion(versionId);
      this.previewCache.set(versionId, content);
    } catch {
      this.previewCache.set(versionId, null);
    }
    this.render();
  }

  private renderRefreshButton(container: HTMLElement): void {
    const refresh = container.createEl("button", {
      text: this.loading ? "Refreshing..." : "Refresh",
      cls: "osync-history-refresh",
    });
    refresh.disabled = this.loading;
    refresh.addEventListener("click", () => {
      void this.refresh();
    });
  }

  private async restoreVersion(version: OsyncEntryVersion): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      new ConfirmModal(
        this.app,
        `Restore version from ${formatCapturedAt(version.capturedAt)}?`,
        "Restore",
        resolve,
      ).open();
    });
    if (!confirmed) {
      return;
    }

    this.loading = true;
    this.render();
    try {
      await this.controller.restoreActiveFileVersion(version.versionId);
      new Notice("Version restored.");
      await this.refresh();
    } catch (error) {
      new Notice(
        `Version restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.loading = false;
      this.render();
    }
  }
}

function formatCapturedAt(value: number): string {
  return new Date(value).toLocaleString();
}

function formatReason(reason: OsyncEntryVersion["reason"]): string {
  if (reason === "before_delete") {
    return "Before delete";
  }
  if (reason === "before_restore") {
    return "Before restore";
  }
  if (reason === "manual") {
    return "Manual";
  }
  return "Auto";
}
