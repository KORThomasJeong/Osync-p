/**
 * Remote-vault-domain surface for the settings UI.
 *
 * Exposes the subset of the controller concerned with creating, connecting,
 * and managing the user's remote vault (the unit that holds the encrypted
 * blobs). Sync state and file rules belong on `OsyncSyncFacade`, not here.
 */
export interface OsyncVaultFacade {
  getRemoteVaultStatusLabel(): string;
  hasConnectedRemoteVault(): boolean;
  createRemoteVaultFromPrompt(): Promise<void>;
  connectRemoteVaultFromPrompt(): Promise<void>;
  openRemoteVaultManagementPage(): void;
  disconnectRemoteVault(): Promise<void>;
  changeVaultPasswordFromPrompt(): Promise<void>;
}
