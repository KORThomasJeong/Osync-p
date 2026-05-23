import type { Plugin } from "obsidian";

import { BootstrapCollisionPreviewModal } from "./bootstrap-collision-preview-modal";
import { RemoteVaultManager } from "../remote-vault/manager";
import { RemoteVaultPasswordChangedError } from "../remote-vault/types";
import {
  openBootstrapPasswordChangedRetryModal,
  openBootstrapRemoteVaultModal,
  openChangeVaultPasswordModal,
  openConfirmConnectNonEmptyLocalVaultModal,
  openCreateRemoteVaultModal,
} from "./remote-vault-modals";
import { shouldSyncPath, type SyncFileRules } from "../sync/core/file-rules";
import { SyncTokenManager } from "../sync/remote/token-manager";
import { SyncController } from "../sync/runtime/controller";

export interface OsyncRemoteVaultControllerDeps {
  plugin: Plugin;
  remoteVaultManager: RemoteVaultManager;
  syncController: SyncController;
  syncTokenManager: SyncTokenManager;
  getApiBaseUrl: () => string;
  getSyncFileRules: () => SyncFileRules;
  getStoredRemoteVaultId: () => string | null;
  hasConnectedRemoteVault: () => boolean;
  initializeSyncStoreForActiveRemoteVault: (initialSyncMode?: "download" | "merge") => Promise<void>;
  resetSyncConnection: () => Promise<void>;
  notifyError: (error: unknown, prefix: string) => void;
}

export class OsyncRemoteVaultController {
  constructor(private readonly deps: OsyncRemoteVaultControllerDeps) {}

  async createRemoteVaultFromPrompt(): Promise<void> {
    try {
      if (this.deps.hasConnectedRemoteVault()) {
        throw new Error("Disconnect the current vault before creating another one.");
      }

      const input = await openCreateRemoteVaultModal(this.deps.plugin.app, "");
      if (!input) {
        return;
      }

      await this.deps.remoteVaultManager.createRemoteVault(input);
      await this.deps.initializeSyncStoreForActiveRemoteVault();
      await this.deps.syncController.ensureAutoSyncState();
    } catch (error) {
      this.deps.notifyError(error, "Vault creation failed");
    }
  }

  async connectRemoteVaultFromPrompt(): Promise<void> {
    try {
      if (this.deps.hasConnectedRemoteVault()) {
        throw new Error("Disconnect the current vault before connecting another one.");
      }

      if (this.hasSyncableLocalFiles()) {
        const confirmed = await openConfirmConnectNonEmptyLocalVaultModal(
          this.deps.plugin.app,
        );
        if (!confirmed) {
          return;
        }
      }

      const vaults = await this.deps.remoteVaultManager.listRemoteVaults();
      const input = await openBootstrapRemoteVaultModal(
        this.deps.plugin.app,
        vaults,
        this.deps.getStoredRemoteVaultId(),
      );
      if (!input) {
        return;
      }

      try {
        await this.deps.remoteVaultManager.bootstrapRemoteVault(input);
      } catch (error) {
        if (error instanceof RemoteVaultPasswordChangedError) {
          const reconnected = await this.promptPasswordChangedRetry({
            vaultId: input.vaultId,
            initialSyncMode: input.initialSyncMode,
          });
          if (!reconnected) {
            return;
          }
        } else {
          throw error;
        }
      }
      await this.deps.initializeSyncStoreForActiveRemoteVault(input.initialSyncMode);

      const collisions = await this.previewInitialCollisionsSafely();
      if (collisions.length > 0) {
        const modal = new BootstrapCollisionPreviewModal(
          this.deps.plugin.app,
          collisions,
        );
        const choice = await modal.openAndWait();
        if (!choice) {
          // User cancelled — disconnect to avoid silent merge.
          await this.disconnectRemoteVault();
          return;
        }
        await this.deps.syncController.applyInitialCollisionResolution(
          collisions,
          choice.policy,
        );
        return;
      }
      await this.deps.syncController.ensureAutoSyncState();
    } catch (error) {
      this.deps.notifyError(error, "Vault connection failed");
    }
  }

  private async previewInitialCollisionsSafely() {
    try {
      return await this.deps.syncController.previewInitialCollisions();
    } catch (error) {
      console.error("[osync] previewInitialCollisions failed", error);
      return [];
    }
  }

  async changeVaultPasswordFromPrompt(): Promise<void> {
    try {
      if (!this.deps.hasConnectedRemoteVault()) {
        throw new Error("Connect a vault before changing its password.");
      }

      await openChangeVaultPasswordModal(
        this.deps.plugin.app,
        async (currentPassword, newPassword) => {
          await this.deps.remoteVaultManager.changeVaultPassword(
            currentPassword,
            newPassword,
          );
        },
      );
    } catch (error) {
      this.deps.notifyError(error, "Vault password change failed");
    }
  }

  async promptPasswordChangedRetry(input: {
    vaultId: string;
    initialSyncMode?: "download" | "merge";
  }): Promise<boolean> {
    return await openBootstrapPasswordChangedRetryModal(
      this.deps.plugin.app,
      async (newPassword) => {
        await this.deps.remoteVaultManager.bootstrapRemoteVault({
          vaultId: input.vaultId,
          password: newPassword,
          initialSyncMode: input.initialSyncMode ?? "download",
        });
      },
    );
  }

  openRemoteVaultManagementPage(): void {
    const url = new URL("/vaults", this.deps.getApiBaseUrl()).toString();
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async disconnectRemoteVault(): Promise<void> {
    try {
      await this.deps.remoteVaultManager.disconnectRemoteVault();
    } catch (error) {
      this.deps.notifyError(error, "Vault disconnect failed");
    } finally {
      this.deps.syncTokenManager.clear();
      await this.deps.resetSyncConnection();
    }
  }

  private hasSyncableLocalFiles(): boolean {
    const fileRules = this.deps.getSyncFileRules();
    return this.deps.plugin.app.vault
      .getFiles()
      .some((file) => shouldSyncPath(file.path, fileRules));
  }
}
