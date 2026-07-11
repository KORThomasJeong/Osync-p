import { App, Modal, Setting } from "obsidian";

export async function openPurgeExcludedConfirmModal(
  app: App,
  count: number,
): Promise<boolean> {
  const modal = new PurgeExcludedConfirmModal(app, count);
  return await modal.openAndWait();
}

class PurgeExcludedConfirmModal extends Modal {
  private resolver: ((value: boolean) => void) | null = null;
  private confirmed = false;

  constructor(
    app: App,
    private readonly count: number,
  ) {
    super(app);
  }

  async openAndWait(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Purge excluded folders from server?" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: `${this.count} server entr${this.count === 1 ? "y" : "ies"} in this device's excluded folders will be deleted on the server (and on every other device on next sync).`,
    });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Local files are not touched. Only entries whose path this device excludes are removed. Double-check your excluded-folder settings before confirming.",
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button
          .setButtonText(`Delete ${this.count} on server`)
          .setWarning()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.confirmed);
    this.resolver = null;
  }
}
