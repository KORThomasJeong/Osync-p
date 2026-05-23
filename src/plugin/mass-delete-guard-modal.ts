import { type App, Modal, Setting } from "obsidian";

export type MassDeleteResolution =
  | "restore-from-server"
  | "confirm-delete"
  | "cancel";

export class MassDeleteGuardModal extends Modal {
  private result: MassDeleteResolution = "cancel";
  private resolver: ((value: MassDeleteResolution) => void) | null = null;
  private confirmInput = "";

  constructor(
    app: App,
    private readonly counts: { deleteCount: number; knownEntryCount: number },
  ) {
    super(app);
  }

  async openAndWait(): Promise<MassDeleteResolution> {
    return await new Promise<MassDeleteResolution>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Possible vault deletion detected" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: `${this.counts.deleteCount} of ${this.counts.knownEntryCount} known files appear to have been deleted from disk. Sync is paused. Choose what to do:`,
    });

    new Setting(contentEl)
      .setName("Restore from server")
      .setDesc(
        "Re-download missing files from the server. Recommended if this was unintentional.",
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("Restore")
          .onClick(() => {
            this.result = "restore-from-server";
            this.close();
          }),
      );

    const expected = `delete ${this.counts.deleteCount} files`;
    let confirmButton: ReturnType<Setting["addButton"]> | null = null;
    new Setting(contentEl)
      .setName("Really delete on server")
      .setDesc(`Type "${expected}" to confirm.`)
      .addText((text) => {
        text.onChange((value) => {
          this.confirmInput = value;
          confirmButton?.components.forEach((component) => {
            if ("setDisabled" in component) {
              (component as { setDisabled(disabled: boolean): unknown }).setDisabled(
                value !== expected,
              );
            }
          });
        });
      });

    confirmButton = new Setting(contentEl).addButton((button) => {
      button
        .setButtonText("Confirm delete")
        .setDisabled(true)
        .onClick(() => {
          if (this.confirmInput === expected) {
            this.result = "confirm-delete";
            this.close();
          }
        });
    });

    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Pause sync (decide later)").onClick(() => {
        this.result = "cancel";
        this.close();
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.result);
    this.resolver = null;
  }
}
