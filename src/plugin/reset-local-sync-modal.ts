import { App, Modal, Setting } from "obsidian";

export async function openResetLocalSyncConfirmModal(app: App): Promise<boolean> {
  const modal = new ResetLocalSyncConfirmModal(app);
  return await modal.openAndWait();
}

class ResetLocalSyncConfirmModal extends Modal {
  private resolver: ((value: boolean) => void) | null = null;
  private confirmed = false;

  async openAndWait(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Reset local sync state?" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "This will clear this device's local sync cache and re-download from the server.",
    });

    const list = contentEl.createEl("ul", { cls: "osync-modal-hint" });
    list.createEl("li", { text: "Vault connection and password: kept" });
    list.createEl("li", { text: "Files in this vault folder: kept" });
    list.createEl("li", {
      text: "Pending unsynced changes: lost (re-applied on next sync if local files differ from server)",
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Reset").setCta().onClick(() => {
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
