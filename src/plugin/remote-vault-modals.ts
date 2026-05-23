import { App, Modal, Setting } from "obsidian";

import type {
  BootstrapRemoteVaultInput,
  CreateRemoteVaultInput,
} from "../remote-vault/manager";
import { validateVaultPassword } from "../remote-vault/password-policy";
import {
  RemoteVaultPasswordChangeRejectedError,
  RemoteVaultPasswordChangedError,
  RemoteVaultPasswordIncorrectError,
  type RemoteVaultRecord,
} from "../remote-vault/types";

export async function openCreateRemoteVaultModal(
  app: App,
  initialVaultName: string,
): Promise<CreateRemoteVaultInput | null> {
  const modal = new CreateRemoteVaultModal(app, initialVaultName);
  return await modal.openAndWait();
}

export async function openBootstrapRemoteVaultModal(
  app: App,
  vaults: RemoteVaultRecord[],
  preferredVaultId: string | null,
): Promise<BootstrapRemoteVaultInput | null> {
  const modal = new BootstrapRemoteVaultModal(app, vaults, preferredVaultId);
  return await modal.openAndWait();
}

export async function openConfirmConnectNonEmptyLocalVaultModal(
  app: App,
): Promise<boolean> {
  const modal = new ConfirmConnectNonEmptyLocalVaultModal(app);
  return await modal.openAndWait();
}

export async function openChangeVaultPasswordModal(
  app: App,
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>,
): Promise<boolean> {
  const modal = new ChangeVaultPasswordModal(app, changePassword);
  return await modal.openAndWait();
}

export async function openBootstrapPasswordChangedRetryModal(
  app: App,
  reconnect: (newPassword: string) => Promise<void>,
): Promise<boolean> {
  const modal = new BootstrapPasswordChangedRetryModal(app, reconnect);
  return await modal.openAndWait();
}

class CreateRemoteVaultModal extends Modal {
  private resolver: ((value: CreateRemoteVaultInput | null) => void) | null = null;
  private result: CreateRemoteVaultInput | null = null;
  private vaultName: string;
  private password = "";
  private confirmPassword = "";

  constructor(app: App, initialVaultName: string) {
    super(app);
    this.vaultName = initialVaultName;
  }

  async openAndWait(): Promise<CreateRemoteVaultInput | null> {
    return await new Promise<CreateRemoteVaultInput | null>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    let createButton: { setDisabled(value: boolean): unknown } | null = null;
    const updateCreateButtonState = (): void => {
      const validationError = this.getValidationError();
      createButton?.setDisabled(validationError !== null);
    };
    let passwordErrorEl: { setText(value: string): unknown } | null = null;
    const updatePasswordError = (): void => {
      passwordErrorEl?.setText(this.getPasswordValidationError() ?? "");
    };

    contentEl.createEl("h2", { text: "Create Vault" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Create a new vault and wrap its vault key with a password on this device.",
    });

    new Setting(contentEl)
      .setName("Vault name")
      .setDesc("A display name for this vault. The server will generate the vault ID.")
      .addText((text) => {
        text.setPlaceholder("Personal").setValue(this.vaultName).onChange((value) => {
          this.vaultName = value.trim();
          updateCreateButtonState();
        });
      });

    new Setting(contentEl)
      .setName("Password")
      .setDesc("Used to wrap the vault key locally before upload.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.setPlaceholder("Enter vault password").onChange((value) => {
          this.password = value;
          updatePasswordError();
          updateCreateButtonState();
        });
      });

    new Setting(contentEl)
      .setName("Confirm password")
      .setDesc("Repeat the same password.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.setPlaceholder("Repeat vault password").onChange((value) => {
          this.confirmPassword = value;
          updatePasswordError();
          updateCreateButtonState();
        });
      });

    passwordErrorEl = contentEl.createEl("p", {
      cls: "osync-modal-error",
    });
    updatePasswordError();

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Create vault").setCta().onClick(async () => {
          if (this.getValidationError() !== null) {
            updatePasswordError();
            updateCreateButtonState();
            return;
          }

          const confirmed = await new ConfirmCreateRemoteVaultBackupModal(this.app).openAndWait();
          if (!confirmed) {
            return;
          }

          this.result = {
            name: this.vaultName,
            password: this.password,
            confirmPassword: this.confirmPassword,
          };
          this.close();
        });
        createButton = button;
        updateCreateButtonState();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.result);
    this.resolver = null;
  }

  private getValidationError(): string | null {
    if (!this.vaultName.trim()) {
      return "Vault name is required.";
    }

    const passwordValidation = validateVaultPassword(this.password);
    if (!passwordValidation.ok) {
      return passwordValidation.message;
    }

    if (this.password !== this.confirmPassword) {
      return "Passwords do not match.";
    }

    return null;
  }

  private getPasswordValidationError(): string | null {
    if (this.password === "" && this.confirmPassword === "") {
      return null;
    }

    const passwordValidation = validateVaultPassword(this.password);
    if (!passwordValidation.ok) {
      return passwordValidation.message;
    }

    if (this.confirmPassword !== "" && this.password !== this.confirmPassword) {
      return "Passwords do not match.";
    }

    return null;
  }
}

class ConfirmCreateRemoteVaultBackupModal extends Modal {
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

    contentEl.createEl("h2", { text: "Back Up Your Vault" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Creating a remote vault can affect this local Obsidian vault's file structure or sync state.",
    });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Back up your vault before continuing.",
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("I backed up, create vault").setCta().onClick(() => {
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

class ConfirmConnectNonEmptyLocalVaultModal extends Modal {
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

    contentEl.createEl("h2", { text: "Connect Vault" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "This local vault already contains files.",
    });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Connecting it may cause unexpected sync conflicts.",
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Connect anyway").setCta().onClick(() => {
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

class BootstrapRemoteVaultModal extends Modal {
  private resolver: ((value: BootstrapRemoteVaultInput | null) => void) | null = null;
  private result: BootstrapRemoteVaultInput | null = null;
  private readonly vaults: RemoteVaultRecord[];
  private selectedVaultId: string;
  private password = "";
  private initialSyncMode: "download" | "merge" = "download";

  constructor(app: App, vaults: RemoteVaultRecord[], preferredVaultId: string | null) {
    super(app);
    this.vaults = vaults;
    this.selectedVaultId =
      preferredVaultId && vaults.some((vault) => vault.id === preferredVaultId)
        ? preferredVaultId
        : vaults[0]?.id ?? "";
  }

  async openAndWait(): Promise<BootstrapRemoteVaultInput | null> {
    return await new Promise<BootstrapRemoteVaultInput | null>((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Connect Vault" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Choose a vault from the server, then enter the password to connect it on this device.",
    });

    if (this.vaults.length === 0) {
      contentEl.createEl("p", {
        cls: "osync-modal-empty",
        text: "No vault exists yet for this account.",
      });

      new Setting(contentEl).addButton((button) => {
        button.setButtonText("Close").setCta().onClick(() => {
          this.close();
        });
      });
      return;
    }

    const selectedLabel = contentEl.createEl("p", {
      cls: "osync-modal-selected",
      text: `Selected: ${this.getSelectedVaultLabel()}`,
    });
    const vaultList = contentEl.createEl("div", {
      cls: "osync-vault-list",
    });
    this.renderVaultButtons(vaultList, selectedLabel);

    new Setting(contentEl)
      .setName("Password")
      .setDesc("Used locally to unwrap the vault key.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "current-password";
        text.setPlaceholder("Enter vault password").onChange((value) => {
          this.password = value;
        });
      });

    new Setting(contentEl)
      .setName("Sync direction")
      .setDesc(
        this.initialSyncMode === "download"
          ? "Server files will be downloaded. Local files will not be deleted."
          : "Server and local changes will be merged. Remote deletions are applied.",
      );

    const directionEl = contentEl.createEl("div", { cls: "osync-sync-direction-options" });

    const downloadLabel = directionEl.createEl("label", { cls: "osync-sync-direction-option" });
    const downloadRadio = downloadLabel.createEl("input");
    downloadRadio.type = "radio";
    downloadRadio.name = "sync-direction";
    downloadRadio.value = "download";
    downloadRadio.checked = this.initialSyncMode === "download";
    downloadLabel.appendText(" Download from server (safe for new devices)");

    const mergeLabel = directionEl.createEl("label", { cls: "osync-sync-direction-option" });
    const mergeRadio = mergeLabel.createEl("input");
    mergeRadio.type = "radio";
    mergeRadio.name = "sync-direction";
    mergeRadio.value = "merge";
    mergeRadio.checked = this.initialSyncMode === "merge";
    mergeLabel.appendText(" Merge (apply all server changes including deletions)");

    downloadRadio.addEventListener("change", () => {
      if (downloadRadio.checked) this.initialSyncMode = "download";
    });
    mergeRadio.addEventListener("change", () => {
      if (mergeRadio.checked) this.initialSyncMode = "merge";
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Connect vault").setCta().onClick(() => {
          this.result = {
            vaultId: this.selectedVaultId,
            password: this.password,
            initialSyncMode: this.initialSyncMode,
          };
          this.close();
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.result);
    this.resolver = null;
  }

  private renderVaultButtons(containerEl: HTMLElement, selectedLabel: HTMLParagraphElement): void {
    containerEl.empty();

    for (const vault of this.vaults) {
      const button = containerEl.createEl("button", {
        cls: "osync-vault-option",
        text: vault.name,
      });
      button.type = "button";

      if (vault.id === this.selectedVaultId) {
        button.addClass("is-selected");
      }

      button.addEventListener("click", () => {
        this.selectedVaultId = vault.id;
        selectedLabel.setText(`Selected: ${this.getSelectedVaultLabel()}`);
        this.renderVaultButtons(containerEl, selectedLabel);
      });

    }
  }

  private getSelectedVaultLabel(): string {
    const selectedVault = this.vaults.find((vault) => vault.id === this.selectedVaultId);
    if (!selectedVault) {
      return "None";
    }

    return selectedVault.name;
  }
}

class ChangeVaultPasswordModal extends Modal {
  private resolver: ((value: boolean) => void) | null = null;
  private succeeded = false;
  private currentPassword = "";
  private newPassword = "";
  private confirmNewPassword = "";
  private submitting = false;

  constructor(
    app: App,
    private readonly changePassword: (
      currentPassword: string,
      newPassword: string,
    ) => Promise<void>,
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

    contentEl.createEl("h2", { text: "Change Vault Password" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "Re-wrap this vault's key with a new password. The vault key itself does not change, so other connected devices keep syncing.",
    });

    let submitButton: { setDisabled(value: boolean): unknown } | null = null;
    const updateSubmitButtonState = (): void => {
      const validationError = this.getValidationError();
      submitButton?.setDisabled(this.submitting || validationError !== null);
    };

    let inlineErrorEl: { setText(value: string): unknown } | null = null;
    const showInlineError = (message: string): void => {
      inlineErrorEl?.setText(message);
    };
    const updateInlineValidationError = (): void => {
      const validation = this.getInlineValidationError();
      showInlineError(validation ?? "");
    };

    new Setting(contentEl)
      .setName("Current password")
      .setDesc("The password currently used to wrap this vault's key.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "current-password";
        text.setPlaceholder("Current vault password").onChange((value) => {
          this.currentPassword = value;
          updateInlineValidationError();
          updateSubmitButtonState();
        });
      });

    new Setting(contentEl)
      .setName("New password")
      .setDesc("The new password for wrapping this vault's key on this device.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.setPlaceholder("New vault password").onChange((value) => {
          this.newPassword = value;
          updateInlineValidationError();
          updateSubmitButtonState();
        });
      });

    new Setting(contentEl)
      .setName("Confirm new password")
      .setDesc("Repeat the new password.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.setPlaceholder("Repeat new vault password").onChange((value) => {
          this.confirmNewPassword = value;
          updateInlineValidationError();
          updateSubmitButtonState();
        });
      });

    inlineErrorEl = contentEl.createEl("p", {
      cls: "osync-modal-error",
    });
    updateInlineValidationError();

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          if (this.submitting) {
            return;
          }
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Change password").setCta().onClick(async () => {
          if (this.submitting) {
            return;
          }
          if (this.getValidationError() !== null) {
            updateInlineValidationError();
            updateSubmitButtonState();
            return;
          }

          this.submitting = true;
          updateSubmitButtonState();
          showInlineError("");
          try {
            await this.changePassword(this.currentPassword, this.newPassword);
            this.succeeded = true;
            this.close();
          } catch (error) {
            showInlineError(this.formatErrorMessage(error));
          } finally {
            this.submitting = false;
            updateSubmitButtonState();
          }
        });
        submitButton = button;
        updateSubmitButtonState();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.succeeded);
    this.resolver = null;
  }

  private getValidationError(): string | null {
    if (!this.currentPassword) {
      return "Current password is required.";
    }

    const passwordValidation = validateVaultPassword(this.newPassword);
    if (!passwordValidation.ok) {
      return passwordValidation.message;
    }

    if (this.newPassword !== this.confirmNewPassword) {
      return "New passwords do not match.";
    }

    return null;
  }

  private getInlineValidationError(): string | null {
    if (this.newPassword === "" && this.confirmNewPassword === "") {
      return null;
    }

    const passwordValidation = validateVaultPassword(this.newPassword);
    if (!passwordValidation.ok) {
      return passwordValidation.message;
    }

    if (this.confirmNewPassword !== "" && this.newPassword !== this.confirmNewPassword) {
      return "New passwords do not match.";
    }

    return null;
  }

  private formatErrorMessage(error: unknown): string {
    if (error instanceof RemoteVaultPasswordIncorrectError) {
      return "Current password is incorrect.";
    }
    if (error instanceof RemoteVaultPasswordChangeRejectedError) {
      switch (error.code) {
        case "fingerprint_unset":
          return "This vault was created before password change was supported and cannot be changed yet.";
        case "fingerprint_mismatch":
          return "Refusing to change password — the new envelope does not match the stored vault. Please report this.";
        case "wrapper_not_found":
          return "Your wrapper for this vault was not found on the server.";
      }
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

class BootstrapPasswordChangedRetryModal extends Modal {
  private resolver: ((value: boolean) => void) | null = null;
  private succeeded = false;
  private password = "";
  private submitting = false;

  constructor(
    app: App,
    private readonly reconnect: (newPassword: string) => Promise<void>,
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

    contentEl.createEl("h2", { text: "Vault Password Changed" });
    contentEl.createEl("p", {
      cls: "osync-modal-hint",
      text: "The vault password changed on another device. Please enter the current password to reconnect this device.",
    });

    let submitButton: { setDisabled(value: boolean): unknown } | null = null;
    const updateSubmitButtonState = (): void => {
      submitButton?.setDisabled(this.submitting || this.password.length === 0);
    };

    let inlineErrorEl: { setText(value: string): unknown } | null = null;
    const showInlineError = (message: string): void => {
      inlineErrorEl?.setText(message);
    };

    new Setting(contentEl)
      .setName("Vault password")
      .setDesc("Used locally to unwrap the vault key.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "current-password";
        text.setPlaceholder("Enter vault password").onChange((value) => {
          this.password = value;
          updateSubmitButtonState();
        });
      });

    inlineErrorEl = contentEl.createEl("p", {
      cls: "osync-modal-error",
    });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          if (this.submitting) {
            return;
          }
          this.close();
        });
      })
      .addButton((button) => {
        button.setButtonText("Reconnect").setCta().onClick(async () => {
          if (this.submitting || this.password.length === 0) {
            return;
          }

          this.submitting = true;
          updateSubmitButtonState();
          showInlineError("");
          try {
            await this.reconnect(this.password);
            this.succeeded = true;
            this.close();
          } catch (error) {
            showInlineError(this.formatErrorMessage(error));
          } finally {
            this.submitting = false;
            updateSubmitButtonState();
          }
        });
        submitButton = button;
        updateSubmitButtonState();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver?.(this.succeeded);
    this.resolver = null;
  }

  private formatErrorMessage(error: unknown): string {
    if (error instanceof RemoteVaultPasswordChangedError) {
      return "Password is incorrect. Please try again.";
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
