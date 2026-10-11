import { Notice, type Plugin, TFolder } from "obsidian";

import { AuthManager } from "../auth/manager";
import { StoreCorruptionModal, UrlUpdateModal } from "../settings/settings-tab/modals";
import type { SyncStoreCorruptionEvent } from "../sync/store/ports";
import { OsyncPluginDataStore } from "../plugin-data";
import type { OsyncSettingsController } from "../settings/controller";
import { OsyncSettingsStore } from "../settings/store";
import { MassDeleteGuardModal } from "./mass-delete-guard-modal";
import { openPurgeExcludedConfirmModal } from "./purge-excluded-modal";
import { OSYNC_CONFLICT_VIEW_TYPE } from "./conflict-resolution-view";
import { OsyncRemoteVaultController } from "./remote-vault-controller";
import { OsyncVersionHistoryController } from "./version-history-controller";
import type { VersionHistoryViewState } from "./version-history-view";
import { OsyncFileExplorerMarker } from "./file-explorer-marker";
import { ResumeGate } from "./resume-gate";
import { OsyncSyncStatusModal, type OsyncSyncStatusSource } from "./sync-status-modal";
import type { OsyncActivityLogEntry } from "./sync-status-presentation";
import type {
  OsyncConflictCleanupResult,
  OsyncConflictCopy,
  OsyncDeletedFile,
  OsyncEntryVersionCursor,
  OsyncFileRules,
  OsyncStorageStatus,
  OsyncSyncProgress,
  OsyncSyncState,
} from "./view-models";
import {
  findConflictCopies,
  deleteConflictCopies,
  type ConflictCleanupRemover,
  type ConflictCleanupScanner,
} from "../sync/core/conflict-cleanup";
import { normalizeExcludedFolders, type SyncFileRules } from "../sync/core/file-rules";
import type { SyncTokenResponse } from "../sync/remote/client";
import { createVaultLocalActivityLogStorage } from "../sync/runtime/activity-log";
import {
  createVaultLocalUnwritablePathsStorage,
  UNREADABLE_ENTRIES_STORAGE_KEY,
} from "../sync/runtime/device-sync-issues";
import { SyncController } from "../sync/runtime/controller";
import { VaultKeyCryptoService } from "../sync/core/crypto-service";
import { SyncTokenManager } from "../sync/remote/token-manager";
import { readLocalVaultId } from "../sync/store/dexie/local-vault";
import type { StoredRemoteVaultKeySecret } from "../remote-vault/device-storage";
import {
  readRemoteVaultKeySecretForVault,
  releaseRemoteVaultKeySecret,
  writeStoredRemoteVaultKeySecret,
} from "../remote-vault/device-storage";
import { RemoteVaultManager } from "../remote-vault/manager";
import {
  readCachedRemoteVaultSummary,
  writeCachedRemoteVaultSummary,
} from "../remote-vault/summary-cache";
import {
  RemoteVaultKeyMismatchError,
  RemoteVaultPasswordChangedError,
} from "../remote-vault/types";
import { VerifyVaultKeyModal, type VaultKeyVerificationSource } from "./verify-vault-key-modal";
import type { SyncConnection } from "../sync/store/store";

export interface OsyncPluginControllerDeps {
  plugin: Plugin;
  refreshUi: () => void;
}

export class OsyncPluginController implements OsyncSettingsController, OsyncSyncStatusSource {
  private readonly plugin = this.deps.plugin;
  private readonly pluginDataStore = new OsyncPluginDataStore(this.plugin);
  private readonly settingsStore = new OsyncSettingsStore(this.pluginDataStore);
  private storedRemoteVaultKeySecret: StoredRemoteVaultKeySecret | null = null;
  private storedSyncConnection: SyncConnection | null = null;
  private readonly resumeGate = new ResumeGate();
  private storeCorruptionNotified = false;
  private fileExplorerMarker: OsyncFileExplorerMarker | null = null;
  private readonly statusListeners = new Set<() => void>();
  private readonly authManager = new AuthManager({
    plugin: this.plugin,
    getApiBaseUrl: () => this.getApiBaseUrl(),
    refreshUi: () => {
      this.refreshUi();
    },
    onSignInUrlError: (message) => {
      new UrlUpdateModal(this.plugin.app, {
        errorMessage: message,
        currentUrl: this.getApiBaseUrl(),
        onSubmit: async (newUrl) => {
          await this.updateApiBaseUrl(newUrl);
        },
      }).open();
    },
  });
  private readonly remoteVaultManager = new RemoteVaultManager({
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
    hasAuthenticatedSession: () => this.authManager.hasAuthenticatedSession(),
    getStoredRemoteVaultId: () => this.storedSyncConnection?.remoteVaultId ?? null,
    getStoredRemoteVaultKeySecret: () => this.storedRemoteVaultKeySecret,
    saveStoredRemoteVaultKeySecret: async (vault) => {
      await this.saveStoredRemoteVaultKeySecret(vault);
    },
    refreshUi: () => {
      this.refreshUi();
    },
    notify: (message) => {
      new Notice(message);
    },
    getCachedRemoteVaultSummary: () => readCachedRemoteVaultSummary(this.pluginDataStore),
    saveCachedRemoteVaultSummary: (summary) => {
      writeCachedRemoteVaultSummary(this.pluginDataStore, summary);
      void this.pluginDataStore.save();
    },
    onStoredKeyMismatch: (vaultId) => {
      void this.handleVaultKeyMismatch(vaultId);
    },
  });
  private readonly syncTokenManager = new SyncTokenManager({
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
    getRemoteVaultId: () => this.remoteVaultManager.getRemoteVaultId(),
    getLocalVaultId: async () => {
      const fromConnection = await this.syncController.readLocalVaultId();
      if (fromConnection) return fromConnection;
      // The store connection is transiently empty during a store reset/reconnect
      // (the IndexedDB may be mid-delete). Fall back to the persistent device
      // identity in localStorage so token issuance doesn't fail with "Local vault
      // ID is not available." while the store re-initializes.
      return readLocalVaultId(this.plugin);
    },
    getKeyFingerprint: async () => await this.remoteVaultManager.getActiveKeyFingerprint(),
  });
  private readonly syncController = new SyncController({
    plugin: this.plugin,
    activityLogStorage: createVaultLocalActivityLogStorage(this.plugin),
    unwritablePathsStorage: createVaultLocalUnwritablePathsStorage(this.plugin),
    unreadableEntriesStorage: createVaultLocalUnwritablePathsStorage(
      this.plugin,
      UNREADABLE_ENTRIES_STORAGE_KEY,
    ),
    onVaultKeyMismatch: () => {
      void this.handleServerKeyMismatch();
    },
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getSyncToken: async () => await this.getSyncTokenForActiveRemoteVault(),
    invalidateSyncToken: () => {
      this.syncTokenManager.clear();
    },
    crypto: new VaultKeyCryptoService(() => this.getActiveRemoteVaultKey()),
    getSyncFileRules: () => this.getSyncFileRules(),
    hasActiveRemoteVaultSession: () => this.hasActiveRemoteVaultSession(),
    hasAuthenticatedSession: () => this.hasAuthenticatedSession(),
    notifyError: (error, prefix) => {
      this.notifyError(error, prefix);
    },
    notify: (message, timeout) => {
      new Notice(message, timeout);
    },
    notifyMassDeleteGuard: (counts) => {
      void this.handleMassDeleteGuard(counts);
    },
    onStatusChange: () => {
      this.refreshUi();
    },
  });
  private readonly versionHistoryController = new OsyncVersionHistoryController({
    plugin: this.plugin,
    syncController: this.syncController,
    getSyncFileRules: () => this.getSyncFileRules(),
    hasAuthenticatedSession: () => this.hasAuthenticatedSession(),
    hasConnectedRemoteVault: () => this.hasConnectedRemoteVault(),
    refreshUi: () => this.refreshUi(),
  });
  private readonly remoteVaultController = new OsyncRemoteVaultController({
    plugin: this.plugin,
    remoteVaultManager: this.remoteVaultManager,
    syncController: this.syncController,
    syncTokenManager: this.syncTokenManager,
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getSyncFileRules: () => this.getSyncFileRules(),
    getStoredRemoteVaultId: () => this.storedSyncConnection?.remoteVaultId ?? null,
    hasConnectedRemoteVault: () => this.hasConnectedRemoteVault(),
    initializeSyncStoreForActiveRemoteVault: async (initialSyncMode) => {
      await this.initializeSyncStoreForActiveRemoteVault(initialSyncMode);
    },
    resetSyncConnection: async () => {
      await this.resetSyncConnection();
    },
    notifyError: (error, prefix) => {
      this.notifyError(error, prefix);
    },
  });

  constructor(private readonly deps: OsyncPluginControllerDeps) {}

  async initialize(): Promise<void> {
    await this.pluginDataStore.initialize();
    await this.initializeSettings();
    this.storedSyncConnection = await this.syncController.readStoredConnection();
    const connectedVaultId = this.storedSyncConnection?.remoteVaultId ?? null;
    this.storedRemoteVaultKeySecret = connectedVaultId
      ? await readRemoteVaultKeySecretForVault(this.plugin, connectedVaultId)
      : null;
    await this.authManager.initialize();
    await this.tryRestorePersistedRemoteVaultSession();
    this.registerStoreCorruptionListener();
  }

  async stop(): Promise<void> {
    await this.syncController.stop();
  }

  registerVaultEvents(): void {
    this.syncController.registerVaultEvents();
  }

  isSyncPaused(): boolean {
    return this.settingsStore.getSnapshot().syncPaused;
  }

  async toggleSyncPause(): Promise<void> {
    const paused = !this.isSyncPaused();
    await this.settingsStore.updateSyncPaused(paused);
    if (paused) {
      this.syncController.pauseAutoSync();
    } else {
      this.syncController.resumeAutoSyncFromPause();
    }
    this.refreshUi();
  }

  // Remove server-side entries that live in this device's excluded folders (zombies whose
  // local delete never propagated). Shows a dry-run count and requires confirmation before
  // queueing the deletes, then pushes them so the server tombstones them.
  async purgeExcludedFoldersFromServer(): Promise<void> {
    try {
      const count = await this.syncController.countExcludedRemoteEntries();
      if (count === 0) {
        new Notice("Osync: No excluded-folder entries on the server to purge.");
        return;
      }
      const confirmed = await openPurgeExcludedConfirmModal(this.plugin.app, count);
      if (!confirmed) return;
      const purged = await this.syncController.purgeExcludedRemoteEntries();
      await this.ensureAutoSyncState();
      new Notice(`Osync: Queued ${purged} excluded entr${purged === 1 ? "y" : "ies"} for deletion on the server.`);
    } catch (error) {
      this.notifyError(error, "Purge excluded folders failed");
    }
  }

  ensureAutoSyncState(): Promise<void> {
    const base = this.syncController.ensureAutoSyncState();
    if (this.isSyncPaused()) {
      return base.then(() => {
        this.syncController.pauseAutoSync();
        this.fileExplorerMarker?.refresh();
      });
    }
    return base.then(() => {
      this.fileExplorerMarker?.refresh();
    });
  }

  initializeFileExplorerMarker(): void {
    this.fileExplorerMarker = new OsyncFileExplorerMarker(
      this.plugin.app,
      () => this.syncController.getMaxFileSizeBytes(),
    );
    this.fileExplorerMarker.refresh();
  }

  refreshFileExplorerMarker(): void {
    this.fileExplorerMarker?.refresh();
  }

  notifyFileExplorerMarkerChanged(): void {
    this.fileExplorerMarker?.notifyFileChanged();
  }

  unloadFileExplorerMarker(): void {
    this.fileExplorerMarker?.unload();
  }

  queueAutoSyncResume(): void {
    // Deduped, but self-healing: a resume hung past RESUME_STALE_AFTER_MS
    // (e.g. a request stuck across a mobile network change) stops blocking
    // later focus/visibility/online triggers.
    this.resumeGate.trigger(
      () => this.recoverAndResume(),
      (error) => {
        this.notifyError(error, "Auto sync resume failed");
      },
    );
  }

  private async recoverAndResume(): Promise<void> {
    await this.authManager.reverifyIfNeeded();
    if (
      this.hasAuthenticatedSession() &&
      !this.hasActiveRemoteVaultSession() &&
      this.storedRemoteVaultKeySecret
    ) {
      // Offline-capable restore: reconstructs the in-memory vault session from
      // locally stored material and re-initializes the sync store so transient
      // network loss self-heals without a manual reconnect.
      await this.tryRestorePersistedRemoteVaultSession();
    }
    await this.syncController.resumeAutoSync();
  }

  getAuthStatusLabel(): string {
    return this.authManager.getAuthStatusLabel();
  }

  hasAuthenticatedSession(): boolean {
    return this.authManager.hasAuthenticatedSession();
  }

  isDeviceLoginInProgress(): boolean {
    return this.authManager.isDeviceLoginInProgress();
  }

  getRemoteVaultStatusLabel(): string {
    return this.remoteVaultManager.getRemoteVaultStatusLabel();
  }

  hasConnectedRemoteVault(): boolean {
    return this.remoteVaultManager.hasConnectedRemoteVault();
  }

  getSyncStatusLabel(): string {
    return this.syncController.getSyncStatusLabel();
  }

  getSyncState(): OsyncSyncState {
    return this.syncController.getSyncState();
  }

  getSyncPercent(): number {
    return this.syncController.getSyncPercent();
  }

  getLastVerifiedAt(): number | null {
    return this.syncController.getLastVerifiedAt();
  }

  getSyncProgress(): OsyncSyncProgress {
    return this.syncController.getSyncProgress();
  }

  getStorageStatus(): OsyncStorageStatus | null {
    return this.syncController.getStorageStatus();
  }

  getApiBaseUrl(): string {
    return this.settingsStore.getSnapshot().apiBaseUrl;
  }

  watchStorageStatus(): void {
    this.syncController.watchStorageStatus();
  }

  unwatchStorageStatus(): void {
    this.syncController.unwatchStorageStatus();
  }

  getSyncFileRules(): OsyncFileRules {
    return this.settingsStore.getSnapshot().fileRules;
  }

  listSelectableExcludedFolderPaths(): string[] {
    return this.plugin.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path)
      .filter((path) => path.length > 0)
      .filter((path) => !path.split("/").some((segment) => segment.startsWith(".")))
      .sort((left, right) => left.localeCompare(right));
  }

  async updateSyncFileRule<K extends keyof OsyncFileRules>(
    key: K,
    value: OsyncFileRules[K],
  ): Promise<void> {
    await this.updateSyncFileRules({
      ...this.getSyncFileRules(),
      [key]: value,
    });
  }

  async updateExcludedFolders(paths: string[]): Promise<void> {
    await this.updateSyncFileRules({
      ...this.getSyncFileRules(),
      excludedFolders: normalizeExcludedFolders(paths),
    });
  }

  async updateApiBaseUrl(value: string): Promise<void> {
    if (this.hasAuthenticatedSession() && this.getApiBaseUrl()) {
      throw new Error("Sign out before changing the API server.");
    }
    if (this.isDeviceLoginInProgress()) {
      throw new Error("Finish or cancel sign-in before changing the API server.");
    }
    if (this.hasConnectedRemoteVault()) {
      if (this.hasAuthenticatedSession()) {
        throw new Error("Disconnect the current vault before changing the API server.");
      }
      // Not authenticated but stale vault credentials remain — reset them silently.
      await this.resetSyncConnection();
      this.remoteVaultManager.clearSession();
      await this.saveStoredRemoteVaultKeySecret(null);
    }

    const changed = await this.settingsStore.updateApiBaseUrl(value);
    if (changed) {
      this.refreshUi();
    }
  }

  async getSyncTokenForActiveRemoteVault(): Promise<SyncTokenResponse> {
    return await this.syncTokenManager.getTokenForActiveRemoteVault();
  }

  async beginDeviceLogin(): Promise<void> {
    let loginStarted = false;

    try {
      loginStarted = await this.authManager.beginDeviceLogin();
      if (loginStarted) {
        await this.tryRestorePersistedRemoteVaultSession();
      }
    } finally {
      if (loginStarted) {
        this.syncTokenManager.clear();
        await this.syncController.ensureAutoSyncState();
      }
    }
  }

  async signOutDevice(): Promise<void> {
    try {
      await this.authManager.signOutDevice();
    } finally {
      this.syncTokenManager.clear();
      this.remoteVaultManager.clearSession();
      await this.saveStoredRemoteVaultKeySecret(null);
      await this.resetSyncConnection();
    }
  }

  async createRemoteVaultFromPrompt(): Promise<void> {
    await this.remoteVaultController.createRemoteVaultFromPrompt();
  }

  async connectRemoteVaultFromPrompt(): Promise<void> {
    await this.remoteVaultController.connectRemoteVaultFromPrompt();
  }

  openRemoteVaultManagementPage(): void {
    this.remoteVaultController.openRemoteVaultManagementPage();
  }

  async disconnectRemoteVault(): Promise<void> {
    await this.remoteVaultController.disconnectRemoteVault();
  }

  async changeVaultPasswordFromPrompt(): Promise<void> {
    await this.remoteVaultController.changeVaultPasswordFromPrompt();
  }

  async openVersionHistoryPane(): Promise<void> {
    await this.versionHistoryController.openPane();
  }

  getConflictQueue() {
    return this.syncController.getConflictQueue();
  }

  async openConflictResolutionPane(): Promise<void> {
    const workspace = this.plugin.app.workspace;
    const existing = workspace.getLeavesOfType(OSYNC_CONFLICT_VIEW_TYPE)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) {
      throw new Error("Unable to open the right sidebar.");
    }
    await leaf.setViewState({
      type: OSYNC_CONFLICT_VIEW_TYPE,
      active: true,
    });
    await workspace.revealLeaf(leaf);
  }

  // --- Sync status modal / ribbon (OsyncSyncStatusSource) ---

  openSyncStatus(): void {
    new OsyncSyncStatusModal(this.plugin.app, this).open();
  }

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    const unsubscribeConflicts = this.getConflictQueue().onChange(listener);
    return () => {
      this.statusListeners.delete(listener);
      unsubscribeConflicts();
    };
  }

  getConflictCount(): number {
    return this.getConflictQueue().count();
  }

  openConflicts(): void {
    void this.openConflictResolutionPane().catch((error: unknown) => {
      this.notifyError(error, "Open sync conflicts failed");
    });
  }

  async checkNow(): Promise<void> {
    await this.syncController.checkNow();
  }

  async getPendingUploadCount(): Promise<number> {
    return await this.syncController.getPendingUploadCount();
  }

  getActivityLog(): readonly OsyncActivityLogEntry[] {
    return this.syncController.getActivityLog();
  }

  onActivityLogChange(listener: () => void): () => void {
    return this.syncController.onActivityLogChange(listener);
  }

  clearActivityLog(): void {
    this.syncController.clearActivityLog();
  }

  getUnwritablePaths(): readonly { path: string; reason: string; at: number }[] {
    return this.syncController.getUnwritablePaths();
  }

  getPortabilityWarnings(): readonly { path: string; reason: string }[] {
    return this.syncController.getPortabilityWarnings();
  }

  onDeviceSyncIssuesChange(listener: () => void): () => void {
    return this.syncController.onDeviceSyncIssuesChange(listener);
  }

  async retryUnwritablePaths(): Promise<void> {
    await this.syncController.retryUnwritablePaths();
  }

  // Best-effort push of pending local changes when the app is backgrounded
  // (iOS may suspend it right after). Silent: no notice on failure.
  flushSyncOnHide(): void {
    if (this.isSyncPaused()) return;
    try {
      void Promise.resolve(this.syncController.flushPendingNow()).catch((error: unknown) => {
        console.warn("[osync:flush-on-hide] failed", error);
      });
    } catch (error) {
      console.warn("[osync:flush-on-hide] failed", error);
    }
  }

  async listActiveFileVersions(
    before: OsyncEntryVersionCursor | null,
    limit: number,
  ): Promise<VersionHistoryViewState> {
    return await this.versionHistoryController.listActiveFileVersions(before, limit);
  }

  async restoreActiveFileVersion(versionId: string): Promise<void> {
    await this.versionHistoryController.restoreActiveFileVersion(versionId);
  }

  async previewActiveFileVersion(versionId: string): Promise<string | null> {
    return await this.versionHistoryController.previewActiveFileVersion(versionId);
  }

  async listConflictCopies(): Promise<OsyncConflictCopy[]> {
    const scanner: ConflictCleanupScanner = {
      listFiles: async () => {
        return this.plugin.app.vault.getFiles().map((file) => ({
          path: file.path,
          size: file.stat.size,
          mtime: file.stat.mtime,
        }));
      },
    };
    const entries = await findConflictCopies(scanner);
    return entries.map((entry) => ({
      path: entry.path,
      size: entry.size,
      mtime: entry.mtime,
    }));
  }

  async deleteConflictCopies(
    paths: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<OsyncConflictCleanupResult> {
    if (paths.length === 0) {
      return { successCount: 0, failures: [] };
    }
    const remover: ConflictCleanupRemover = {
      remove: async (path: string) => {
        await this.plugin.app.vault.adapter.remove(path);
      },
    };
    console.info(`[osync:conflict-cleanup] starting delete of ${paths.length} files`);
    const result = await deleteConflictCopies(remover, paths, { onProgress });
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.error(`[osync:conflict-cleanup] failed to delete ${failure.path}: ${failure.error}`);
      }
    }
    console.info(
      `[osync:conflict-cleanup] done — success=${result.successCount} failed=${result.failures.length}`,
    );
    return result;
  }

  async listDeletedFiles(): Promise<OsyncDeletedFile[]> {
    return await this.versionHistoryController.listDeletedFiles();
  }

  async restoreDeletedFiles(entryIds: string[]): Promise<{ restored: number; failed: number }> {
    return await this.versionHistoryController.restoreDeletedFiles(entryIds);
  }

  refreshVersionHistoryViews(): void {
    this.versionHistoryController.refreshViews();
  }

  private refreshUi(): void {
    this.deps.refreshUi();
    this.notifyStatusListeners();
  }

  private notifyStatusListeners(): void {
    for (const listener of [...this.statusListeners]) {
      try {
        listener();
      } catch (error) {
        console.warn("[osync:status] listener failed", error);
      }
    }
  }

  // Keys live in app-wide secret storage (shared by every local vault on the device),
  // so each is stored under its own remote vault id; see device-storage.ts.
  private async saveStoredRemoteVaultKeySecret(
    vault: StoredRemoteVaultKeySecret | null,
  ): Promise<void> {
    const previous = this.storedRemoteVaultKeySecret;
    if (vault) {
      if (!vault.vaultId) {
        throw new Error("internal: a vault key must be stored with its vault id");
      }
      await writeStoredRemoteVaultKeySecret(this.plugin, { ...vault, vaultId: vault.vaultId });
      this.storedRemoteVaultKeySecret = vault;
      this.refreshUi();
      return;
    }

    this.storedRemoteVaultKeySecret = null;
    const vaultId =
      previous?.vaultId ??
      this.remoteVaultManager.getRemoteVaultId() ??
      this.storedSyncConnection?.remoteVaultId ??
      null;
    if (vaultId) {
      await releaseRemoteVaultKeySecret(this.plugin, vaultId, previous);
    }
    this.refreshUi();
  }

  // --- Vault key verification ---

  openVerifyVaultKey(): void {
    new VerifyVaultKeyModal(this.plugin.app, this.createVaultKeyVerificationSource()).open();
  }

  getUnreadableEntryCount(): number {
    return this.syncController.getUnreadableEntryCount();
  }

  private createVaultKeyVerificationSource(): VaultKeyVerificationSource {
    return {
      getVaultName: () => this.remoteVaultManager.getActiveSession()?.summary.vaultName ?? "",
      getKeyFingerprints: async () => await this.readKeyFingerprints(),
      scanUnreadableEntries: async (onProgress) =>
        await this.syncController.scanUnreadableEntries(onProgress),
      removeUnreadableEntries: async (targets) => {
        // Re-verify right before deleting anything: removal is only safe with the
        // vault's own key (a wrong key would see healthy entries as unreadable).
        const fingerprints = await this.readKeyFingerprints();
        if (!fingerprints.local || fingerprints.local !== fingerprints.server) {
          throw new Error("This device's vault key could not be verified; nothing was removed.");
        }
        return await this.syncController.removeUnreadableEntries(targets);
      },
      reuploadLocalCopies: async (entryIds) =>
        await this.syncController.reuploadUnreadableLocalEntries(entryIds),
      reenterVaultPassword: () => {
        void this.handleServerKeyMismatch();
      },
    };
  }

  private async readKeyFingerprints(): Promise<{ local: string | null; server: string | null }> {
    const local = await this.remoteVaultManager.getActiveKeyFingerprint();
    if (!local) {
      return { local: null, server: null };
    }
    return { local, server: await this.remoteVaultManager.fetchServerKeyFingerprint() };
  }

  // The server refused this device's key, or the user chose to re-enter the password
  // after a failed verification: drop the key, then ask for the vault password.
  private async handleServerKeyMismatch(): Promise<void> {
    const vaultId =
      (await this.remoteVaultManager.rejectActiveVaultKey()) ??
      this.storedSyncConnection?.remoteVaultId ??
      null;
    if (vaultId) {
      await this.handleVaultKeyMismatch(vaultId);
    }
  }

  private vaultKeyReentry: Promise<void> | null = null;

  // The key stored for this vault is not its key. Sync stays stopped until the user
  // re-enters the vault password; then this device's own entries that were encrypted
  // with the wrong key (unreadable now) are re-uploaded from the local files.
  private handleVaultKeyMismatch(vaultId: string): Promise<void> {
    if (this.vaultKeyReentry) {
      return this.vaultKeyReentry;
    }
    const run = async (): Promise<void> => {
      this.syncTokenManager.clear();
      this.syncController.stopAutoSyncAndMarkNotReady();
      const reconnected = await this.remoteVaultController.promptVaultKeyReentry({ vaultId });
      if (!reconnected) {
        return;
      }
      this.syncTokenManager.clear();
      await this.initializeSyncStoreForActiveRemoteVault();
      await this.reuploadWrongKeyEntries();
      await this.ensureAutoSyncState();
    };
    this.vaultKeyReentry = run()
      .catch((error: unknown) => {
        this.notifyError(error, "Vault key re-entry failed");
      })
      .finally(() => {
        this.vaultKeyReentry = null;
      });
    return this.vaultKeyReentry;
  }

  private async reuploadWrongKeyEntries(): Promise<void> {
    try {
      const scan = await this.syncController.scanUnreadableEntries();
      if (scan.knownLocally.length === 0) {
        return;
      }
      const count = await this.syncController.reuploadUnreadableLocalEntries(scan.knownLocally);
      if (count > 0) {
        new Notice(
          `Osync: ${count} local file${count === 1 ? "" : "s"} written with the wrong key will be uploaded again.`,
        );
      }
    } catch (error) {
      // Not fatal: "Verify vault key" can run the same repair later.
      console.warn("[osync] vault key: re-upload of unreadable local entries failed", error);
    }
  }

  private async tryRestorePersistedRemoteVaultSession(): Promise<void> {
    try {
      await this.remoteVaultManager.restorePersistedRemoteVaultSession();
      await this.initializeSyncStoreForActiveRemoteVault();
    } catch (error) {
      if (error instanceof RemoteVaultKeyMismatchError) {
        // Not awaited: the prompt waits for the user and must not hold up plugin load.
        void this.handleVaultKeyMismatch(error.vaultId);
        return;
      }
      if (error instanceof RemoteVaultPasswordChangedError) {
        const storedVaultId = this.storedSyncConnection?.remoteVaultId ?? null;
        if (storedVaultId) {
          const reconnected = await this.remoteVaultController.promptPasswordChangedRetry({
            vaultId: storedVaultId,
          });
          if (reconnected) {
            await this.initializeSyncStoreForActiveRemoteVault();
          }
        }
        return;
      }
      this.notifyError(error, "Vault restore failed");
    }
  }

  private registerStoreCorruptionListener(): void {
    this.syncController.setStoreCorruptionListener((event: SyncStoreCorruptionEvent) => {
      this.handleStoreCorruption(event);
    });
  }

  private handleStoreCorruption(event: SyncStoreCorruptionEvent): void {
    if (this.storeCorruptionNotified) return;
    this.storeCorruptionNotified = true;
    console.warn(`[osync:store-corruption] surfaced to user — entry=${event.entryId}`);
    const notice = new Notice(
      "Osync: sync store conflict detected. Tap for recovery options.",
      0,
    );
    notice.messageEl.addEventListener("click", () => {
      notice.hide();
      new StoreCorruptionModal(this.plugin.app, {
        resetLocalSyncState: () => this.resetLocalSyncStateInPlace(),
      }).open();
    });
  }

  private async initializeSyncStoreForActiveRemoteVault(
    initialSyncMode?: "download" | "merge",
  ): Promise<void> {
    const remoteVaultId = this.remoteVaultManager.getRemoteVaultId();
    if (!remoteVaultId) {
      return;
    }

    await this.syncController.initializeStore(remoteVaultId, initialSyncMode);
    this.storedSyncConnection = await this.syncController.readStoredConnection();
  }

  private async resetSyncConnection(
    opts?: { preserveLocalVaultId?: boolean },
  ): Promise<void> {
    try {
      await this.syncController.resetLocalSyncState(opts);
      this.storedSyncConnection = null;
    } catch (error) {
      this.notifyError(error, "Local sync state reset failed");
      this.syncController.stopAutoSyncAndMarkNotReady();
    }
  }

  async resetLocalSyncStateInPlace(): Promise<void> {
    this.storeCorruptionNotified = false;
    try {
      // Capture the remote vault id from the active session before we wipe
      // the cached sync connection — getStoredRemoteVaultId reads from
      // storedSyncConnection which resetSyncConnection clears.
      const remoteVaultId = this.remoteVaultManager.getRemoteVaultId();

      // Corruption recovery / user-initiated reset rebuilds the local store but
      // PRESERVES the localVaultId so the device keeps its stable identity and
      // sync continues against the same server-side device record instead of
      // breaking repeatedly.
      await this.resetSyncConnection({ preserveLocalVaultId: true });
      // resetSyncConnection swallows errors and notifies internally; it only
      // clears storedSyncConnection on success. If still set, the inner reset
      // failed — bail out without re-initializing or showing a success Notice.
      if (this.storedSyncConnection !== null) {
        return;
      }
      if (!remoteVaultId) {
        return;
      }

      // The sync token cache is bound to (vaultId, localVaultId). The store was
      // rebuilt, so drop any cached token to force fresh issuance.
      this.syncTokenManager.clear();

      // Fresh sync store with download mode; this writes a new SyncConnection
      // to Dexie and repopulates this.storedSyncConnection with the new
      // localVaultId so subsequent token issuance resolves correctly.
      await this.syncController.initializeStore(remoteVaultId, "download");
      this.storedSyncConnection = await this.syncController.readStoredConnection();

      // Refresh the in-memory vault session in case server-side state
      // diverged. The stored vault key is preserved in secretStorage, so this
      // is non-interactive — no password prompt.
      this.remoteVaultManager.clearSession();
      await this.remoteVaultManager.restorePersistedRemoteVaultSession();
      if (!this.remoteVaultManager.hasConnectedRemoteVault()) {
        // Sticky Notice (timeout=0) so mobile users can read it.
        new Notice(
          "Local sync cleared, but the vault session could not be refreshed. Please reconnect the vault.",
          0,
        );
        return;
      }

      await this.syncController.ensureAutoSyncState();
      new Notice("Local sync state reset. Re-syncing from server…");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Sticky Notice (timeout=0) — required for mobile where the dev console
      // is unavailable. Tap to dismiss.
      new Notice(`Reset local sync state failed: ${message}`, 0);
    }
  }

  private async handleMassDeleteGuard(counts: {
    deleteCount: number;
    knownEntryCount: number;
  }): Promise<void> {
    try {
      const modal = new MassDeleteGuardModal(this.plugin.app, counts);
      const choice = await modal.openAndWait();
      if (choice === "restore-from-server") {
        await this.syncController.restoreVaultFromServer();
      } else if (choice === "confirm-delete") {
        await this.syncController.confirmMassDelete();
      }
    } catch (error) {
      this.notifyError(error, "Mass delete guard handling failed");
    }
  }

  private notifyError(error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`${prefix}: ${message}`);
  }

  private getActiveRemoteVaultKey(): Uint8Array {
    const session = this.remoteVaultManager.getActiveSession();
    if (!session) {
      throw new Error("Vault session is not loaded.");
    }

    return session.remoteVaultKey;
  }

  private async initializeSettings(): Promise<void> {
    try {
      this.settingsStore.initialize();
    } catch (error) {
      this.notifyError(error, "Plugin settings initialization failed");
    }
  }

  private async updateSyncFileRules(nextRules: SyncFileRules): Promise<void> {
    const changed = await this.settingsStore.updateFileRules(nextRules);
    if (!changed) {
      return;
    }

    this.refreshUi();
    await this.syncController.reconcileAfterFileRuleChange();
  }

  private hasActiveRemoteVaultSession(): boolean {
    return this.remoteVaultManager.getActiveSession() !== null;
  }
}
