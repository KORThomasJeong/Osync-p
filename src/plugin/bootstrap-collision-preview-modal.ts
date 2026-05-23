import { type App, Modal, Setting } from "obsidian";

import type { InitialCollisionPreview } from "../sync/runtime/controller";

export type InitialCollisionPolicy = "server-wins" | "local-wins" | "timestamp";

export interface BootstrapCollisionPreviewResult {
  policy: InitialCollisionPolicy;
}

export class BootstrapCollisionPreviewModal extends Modal {
  private resolver:
    | ((value: BootstrapCollisionPreviewResult | null) => void)
    | null = null;
  private result: BootstrapCollisionPreviewResult | null = null;
  private policy: InitialCollisionPolicy = "timestamp";

  constructor(
    app: App,
    private readonly collisions: InitialCollisionPreview[],
  ) {
    super(app);
  }

  async openAndWait(): Promise<BootstrapCollisionPreviewResult | null> {
    return await new Promise<BootstrapCollisionPreviewResult | null>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Path conflicts detected" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: `${this.collisions.length} file(s) on this device have different content than the server. Choose how to resolve before sync starts.`,
    });

    const tableWrap = contentEl.createEl("div", { cls: "osync-collision-list" });
    const header = tableWrap.createEl("div", {
      cls: "osync-collision-row osync-collision-head",
    });
    header.createEl("span", { text: "Path" });
    header.createEl("span", { text: "Local size" });
    header.createEl("span", { text: "Local edited" });
    header.createEl("span", { text: "Server edited" });

    const visible = this.collisions.slice(0, 50);
    for (const collision of visible) {
      const row = tableWrap.createEl("div", { cls: "osync-collision-row" });
      row.createEl("span", { text: collision.path, cls: "osync-collision-path" });
      row.createEl("span", { text: formatBytes(collision.localSize) });
      row.createEl("span", { text: formatTimestamp(collision.localMtime) });
      row.createEl("span", {
        text: formatTimestamp(collision.remoteEditedAt ?? collision.remoteUpdatedAt),
      });
    }
    if (this.collisions.length > visible.length) {
      tableWrap.createEl("p", {
        cls: "osync-collision-more",
        text: `…and ${this.collisions.length - visible.length} more`,
      });
    }

    new Setting(contentEl)
      .setName("Resolution policy")
      .setDesc("Applied to every conflicting file. Other files sync normally.");

    const policyEl = contentEl.createEl("div", { cls: "osync-collision-policy" });
    this.appendPolicyRadio(
      policyEl,
      "timestamp",
      "Use newest timestamp",
      "Per file: keep whichever side was edited more recently. Loser is saved as a sync-conflict copy.",
    );
    this.appendPolicyRadio(
      policyEl,
      "server-wins",
      "Keep server (back up local)",
      "Server content overwrites local. The local version is preserved as a sync-conflict copy.",
    );
    this.appendPolicyRadio(
      policyEl,
      "local-wins",
      "Keep local (push to server)",
      "Local content is uploaded and overwrites the server. The server version is saved as a sync-conflict copy.",
    );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("Continue")
          .onClick(() => {
            this.result = { policy: this.policy };
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.result);
    this.resolver = null;
  }

  private appendPolicyRadio(
    parent: HTMLElement,
    value: InitialCollisionPolicy,
    label: string,
    description: string,
  ): void {
    const wrap = parent.createEl("label", { cls: "osync-collision-policy-option" });
    const radio = wrap.createEl("input");
    radio.type = "radio";
    radio.name = "osync-collision-policy";
    radio.value = value;
    radio.checked = this.policy === value;
    radio.addEventListener("change", () => {
      if (radio.checked) {
        this.policy = value;
      }
    });
    const labelText = wrap.createEl("span", { cls: "osync-collision-policy-label" });
    labelText.createEl("strong", { text: label });
    labelText.createEl("p", {
      cls: "osync-collision-policy-desc",
      text: description,
    });
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 16).replace("T", " ");
}
