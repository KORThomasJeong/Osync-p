import {
  computeVaultKeyFingerprint,
  createPasswordWrappedRemoteVaultKey,
  rewrapRemoteVaultKey,
  unwrapRemoteVaultKeyWithPassword,
} from "./crypto";
import type { StoredRemoteVaultKeySecret } from "./device-storage";
import { validateVaultPassword } from "./password-policy";
import { RemoteVaultClient } from "./client";
import {
  RemoteVaultKeyMismatchError,
  RemoteVaultPasswordChangedError,
  RemoteVaultPasswordIncorrectError,
  VAULT_KEY_MISMATCH_NOTICE,
  type RemoteVaultBootstrapResponse,
  type RemoteVaultKeyWrapperRecord,
  type RemoteVaultRecord,
  type RemoteVaultSession,
  type RemoteVaultSessionSummary,
} from "./types";

export interface CreateRemoteVaultInput {
  name: string;
  password: string;
  confirmPassword: string;
}

export interface BootstrapRemoteVaultInput {
  vaultId: string;
  password: string;
  initialSyncMode: "download" | "merge";
}

export interface RemoteVaultManagerDeps {
  getApiBaseUrl: () => string;
  getAuthSessionToken: () => string;
  hasAuthenticatedSession: () => boolean;
  getStoredRemoteVaultId: () => string | null;
  getStoredRemoteVaultKeySecret: () => StoredRemoteVaultKeySecret | null;
  saveStoredRemoteVaultKeySecret: (
    vault: StoredRemoteVaultKeySecret | null,
  ) => Promise<void>;
  refreshUi: () => void;
  notify: (message: string) => void;
  getCachedRemoteVaultSummary?: () => CachedRemoteVaultSummaryLike | null;
  saveCachedRemoteVaultSummary?: (summary: {
    vaultId: string;
    vaultName: string;
    activeKeyVersion: number;
    keyFingerprint?: string | null;
  }) => void;
  // A restored session turned out (in the background server check) to hold another
  // vault's key. The session is already deactivated and the key dropped.
  onStoredKeyMismatch?: (vaultId: string) => void;
  remoteVaultClient?: RemoteVaultClient;
}

export interface CachedRemoteVaultSummaryLike {
  // Absent in caches written before 2.5.1.
  vaultId?: string;
  vaultName: string;
  activeKeyVersion: number;
  // The server's recorded key fingerprint for vaultId, when known.
  keyFingerprint?: string | null;
}

export class RemoteVaultManager {
  private readonly remoteVaultClient: RemoteVaultClient;
  private session: RemoteVaultSession | null = null;

  constructor(private readonly deps: RemoteVaultManagerDeps) {
    this.remoteVaultClient = deps.remoteVaultClient ?? new RemoteVaultClient();
  }

  getRemoteVaultStatusLabel(): string {
    if (this.session) {
      return `Vault ${formatVaultLabel(this.session.summary)} loaded on this device.`;
    }

    const storedVaultId = this.deps.getStoredRemoteVaultId();
    if (storedVaultId && this.deps.getStoredRemoteVaultKeySecret()) {
      return `Vault ${storedVaultId} is stored on this device but not active.`;
    }

    return "No vault is configured on this device.";
  }

  getActiveSession(): RemoteVaultSession | null {
    return this.session;
  }

  getRemoteVaultId(): string | null {
    return this.session?.summary.vaultId ?? null;
  }

  hasConnectedRemoteVault(): boolean {
    return (
      this.session !== null ||
      (this.deps.getStoredRemoteVaultId() !== null &&
        this.deps.getStoredRemoteVaultKeySecret() !== null)
    );
  }

  clearSession(): void {
    this.session = null;
    this.deps.refreshUi();
  }

  async disconnectRemoteVault(): Promise<void> {
    const vault = this.session?.summary ?? this.deps.getStoredRemoteVaultId();
    this.session = null;
    await this.deps.saveStoredRemoteVaultKeySecret(null);
    this.deps.refreshUi();

    if (vault) {
      this.notify(`Vault ${formatStoredVaultLabel(vault)} disconnected from this device.`);
    }
  }

  async restorePersistedRemoteVaultSession(): Promise<void> {
    if (this.session || !this.deps.hasAuthenticatedSession()) {
      return;
    }

    const remoteVaultId = this.deps.getStoredRemoteVaultId();
    const storedVaultKey = this.deps.getStoredRemoteVaultKeySecret();
    if (!remoteVaultId || !storedVaultKey) {
      return;
    }
    if (storedVaultKey.vaultId !== undefined && storedVaultKey.vaultId !== remoteVaultId) {
      // A key bound to another vault is never usable here.
      return;
    }

    const storedFingerprint =
      storedVaultKey.fingerprint ??
      (await computeVaultKeyFingerprint(storedVaultKey.remoteVaultKey));
    const cached = this.readCachedSummaryFor(remoteVaultId);
    const cachedFingerprint = cached?.keyFingerprint ?? null;

    if (storedVaultKey.vaultId === undefined) {
      // Legacy shared secret (app-wide, written by plugins <= 2.5.0): it may be another
      // vault's key. Adopt it only after verifying it against this vault's fingerprint.
      await this.adoptLegacyVaultKey(
        remoteVaultId,
        storedVaultKey.remoteVaultKey,
        storedFingerprint,
        cachedFingerprint,
      );
      return;
    }

    if (cachedFingerprint && cachedFingerprint !== storedFingerprint) {
      await this.rejectStoredVaultKey(remoteVaultId);
      throw new RemoteVaultKeyMismatchError(remoteVaultId);
    }

    // Restore the session immediately from locally stored material so a restart
    // with no/flaky network still has an active session. Content crypto only
    // needs the raw key and token issuance only needs vaultId + key; the display
    // info (vaultName/activeKeyVersion) is refreshed — and the key re-verified
    // against the server's fingerprint — in the background below. The server also
    // refuses a sync token to a mismatched key, so nothing is uploaded meanwhile.
    this.activateRestoredSession(
      remoteVaultId,
      storedVaultKey.remoteVaultKey,
      storedFingerprint,
      cached,
    );

    void this.refreshRestoredVaultSummary(remoteVaultId);
  }

  // The fingerprint of the key this device encrypts with; null without a session.
  async getActiveKeyFingerprint(): Promise<string | null> {
    const session = this.session;
    if (!session) {
      return null;
    }
    if (!session.keyFingerprint) {
      session.keyFingerprint = await computeVaultKeyFingerprint(session.remoteVaultKey);
    }
    return session.keyFingerprint;
  }

  // The fingerprint the server recorded for the active vault (null when unset).
  async fetchServerKeyFingerprint(): Promise<string | null> {
    const session = this.requireSession();
    const bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      session.summary.vaultId,
    );
    return bootstrap.vault.keyFingerprint ?? null;
  }

  // The server refused the active key (sync token 409 key_mismatch): drop the session
  // and this vault's stored key. Returns the vault id that needs its password again.
  async rejectActiveVaultKey(): Promise<string | null> {
    const vaultId = this.session?.summary.vaultId ?? null;
    if (vaultId) {
      await this.rejectStoredVaultKey(vaultId);
    }
    return vaultId;
  }

  private async adoptLegacyVaultKey(
    remoteVaultId: string,
    legacyKey: Uint8Array,
    legacyFingerprint: string,
    cachedFingerprint: string | null,
  ): Promise<void> {
    let expected: string | null | undefined = cachedFingerprint ?? undefined;
    let bootstrap: RemoteVaultBootstrapResponse | null = null;
    if (expected === undefined) {
      try {
        bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
          this.deps.getApiBaseUrl(),
          this.deps.getAuthSessionToken(),
          remoteVaultId,
        );
      } catch (error) {
        // Offline and nothing cached to verify against: do not trust the shared key.
        // The next restore (online) migrates it, or the user re-enters the password.
        console.warn(
          `[osync] vault key: cannot verify the legacy shared key for vault ${remoteVaultId} offline; not restoring`,
          error,
        );
        return;
      }
      expected = bootstrap.vault.keyFingerprint ?? null;
    }

    if (expected === null) {
      console.log(
        `[osync] vault key: vault ${remoteVaultId} has no recorded key fingerprint; adopting the legacy key unverified`,
      );
    } else if (expected !== legacyFingerprint) {
      // The shared secret belongs to another vault. Leave it in place (that vault may
      // still need to migrate from it) and require this vault's password.
      await this.rejectStoredVaultKey(remoteVaultId);
      throw new RemoteVaultKeyMismatchError(remoteVaultId);
    }

    await this.deps.saveStoredRemoteVaultKeySecret({
      vaultId: remoteVaultId,
      remoteVaultKey: legacyKey,
      fingerprint: legacyFingerprint,
    });
    this.activateRestoredSession(
      remoteVaultId,
      legacyKey,
      legacyFingerprint,
      this.readCachedSummaryFor(remoteVaultId),
    );
    if (bootstrap) {
      this.applyBootstrapSummary(remoteVaultId, bootstrap);
    } else {
      void this.refreshRestoredVaultSummary(remoteVaultId);
    }
  }

  private activateRestoredSession(
    remoteVaultId: string,
    remoteVaultKey: Uint8Array,
    keyFingerprint: string,
    cached: CachedRemoteVaultSummaryLike | null,
  ): void {
    this.session = {
      summary: {
        vaultId: remoteVaultId,
        vaultName: cached?.vaultName ?? remoteVaultId,
        activeKeyVersion: cached?.activeKeyVersion ?? 1,
        bootstrappedAt: new Date().toISOString(),
      },
      remoteVaultKey,
      keyFingerprint,
    };
    this.deps.refreshUi();
  }

  private readCachedSummaryFor(remoteVaultId: string): CachedRemoteVaultSummaryLike | null {
    const cached = this.deps.getCachedRemoteVaultSummary?.() ?? null;
    if (!cached) {
      return null;
    }
    // A summary cached for another vault says nothing about this one.
    if (cached.vaultId !== undefined && cached.vaultId !== remoteVaultId) {
      return null;
    }
    return cached;
  }

  // Never encrypt with a key that is not this vault's: drop it from this device
  // (only this vault's per-vault slot) and tell the user to re-enter the password.
  private async rejectStoredVaultKey(remoteVaultId: string): Promise<void> {
    console.error(
      `[osync] vault key: the stored key does not match vault ${remoteVaultId}'s fingerprint`,
    );
    if (this.session?.summary.vaultId === remoteVaultId) {
      this.session = null;
    }
    await this.deps.saveStoredRemoteVaultKeySecret(null);
    this.deps.refreshUi();
    this.notify(VAULT_KEY_MISMATCH_NOTICE);
  }

  private async refreshRestoredVaultSummary(remoteVaultId: string): Promise<void> {
    let bootstrap: RemoteVaultBootstrapResponse;
    try {
      bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
        this.deps.getApiBaseUrl(),
        this.deps.getAuthSessionToken(),
        remoteVaultId,
      );
    } catch {
      // Offline / transient network failure is expected here. The session
      // stays active using the cached/placeholder summary.
      return;
    }

    // Guard against resurrecting/overwriting a session that was cleared or
    // swapped to a different vault while the network call was in flight.
    if (!this.session || this.session.summary.vaultId !== remoteVaultId) {
      return;
    }

    const serverFingerprint = bootstrap.vault.keyFingerprint ?? null;
    const localFingerprint = await this.getActiveKeyFingerprint();
    if (!this.session || this.session.summary.vaultId !== remoteVaultId) {
      return;
    }
    if (serverFingerprint === null) {
      console.log(
        `[osync] vault key: vault ${remoteVaultId} has no recorded key fingerprint; cannot verify the stored key`,
      );
    } else if (serverFingerprint !== localFingerprint) {
      await this.rejectStoredVaultKey(remoteVaultId);
      this.deps.onStoredKeyMismatch?.(remoteVaultId);
      return;
    }

    this.applyBootstrapSummary(remoteVaultId, bootstrap);
  }

  private applyBootstrapSummary(
    remoteVaultId: string,
    bootstrap: RemoteVaultBootstrapResponse,
  ): void {
    if (!this.session || this.session.summary.vaultId !== remoteVaultId) {
      return;
    }
    this.session.summary.vaultName = bootstrap.vault.name;
    this.session.summary.activeKeyVersion = bootstrap.vault.activeKeyVersion;
    this.deps.saveCachedRemoteVaultSummary?.({
      vaultId: remoteVaultId,
      vaultName: bootstrap.vault.name,
      activeKeyVersion: bootstrap.vault.activeKeyVersion,
      keyFingerprint: bootstrap.vault.keyFingerprint ?? null,
    });
    this.deps.refreshUi();
  }

  async listRemoteVaults(): Promise<RemoteVaultRecord[]> {
    this.ensureAuthenticated();

    const listed = await this.remoteVaultClient.listRemoteVaults(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
    );

    return listed.vaults;
  }

  async createRemoteVault(input: CreateRemoteVaultInput): Promise<RemoteVaultSessionSummary> {
    this.ensureAuthenticated();
    validateCreateInput(input);

    const wrapper = await createPasswordWrappedRemoteVaultKey(input.password);
    const keyFingerprint = await computeVaultKeyFingerprint(wrapper.remoteVaultKey);
    const { vault } = await this.remoteVaultClient.createRemoteVault(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      {
        name: input.name.trim(),
        keyFingerprint,
        initialWrapper: {
          kind: "password",
          envelope: wrapper.envelope,
        },
      },
    );

    const bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      vault.id,
    );
    await this.loadBootstrapRemoteVaultSession(bootstrap, input.password);

    const summary = this.requireSession().summary;
    this.notify(`Vault ${summary.vaultName} created and connected.`);
    return summary;
  }

  async bootstrapRemoteVault(input: BootstrapRemoteVaultInput): Promise<RemoteVaultSessionSummary> {
    this.ensureAuthenticated();

    const vaultId = input.vaultId.trim();
    if (!vaultId) {
      throw new Error("Vault selection is required.");
    }

    const password = input.password;
    if (!password) {
      throw new Error("Password is required.");
    }

    const bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      vaultId,
    );
    await this.loadBootstrapRemoteVaultSession(bootstrap, password);

    const summary = this.requireSession().summary;
    this.notify(`Vault ${summary.vaultName} connected on this device.`);
    return summary;
  }

  async changeVaultPassword(currentPassword: string, newPassword: string): Promise<void> {
    this.ensureAuthenticated();
    const session = this.requireSession();

    const newPasswordValidation = validateVaultPassword(newPassword);
    if (!newPasswordValidation.ok) {
      throw new Error(newPasswordValidation.message);
    }

    const bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      session.summary.vaultId,
    );
    const wrapper = findPasswordWrapper(bootstrap.wrappers);

    let derivedKey: Uint8Array;
    try {
      derivedKey = await unwrapRemoteVaultKeyWithPassword(currentPassword, wrapper.envelope);
    } catch (error) {
      if (isOperationError(error)) {
        throw new RemoteVaultPasswordIncorrectError();
      }
      throw error;
    }

    if (!bytesEqual(derivedKey, session.remoteVaultKey)) {
      throw new Error("internal: derived vault key differs from active session key");
    }

    const newEnvelope = await rewrapRemoteVaultKey(derivedKey, newPassword);
    const keyFingerprint = await computeVaultKeyFingerprint(derivedKey);

    await this.remoteVaultClient.changeVaultPassword(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      session.summary.vaultId,
      { envelope: newEnvelope, keyFingerprint },
    );

    this.notify("Vault password changed on this device.");
  }

  private async loadBootstrapRemoteVaultSession(
    bootstrap: RemoteVaultBootstrapResponse,
    password: string,
  ): Promise<void> {
    const wrapper = findPasswordWrapper(bootstrap.wrappers);
    let remoteVaultKey: Uint8Array;
    try {
      remoteVaultKey = await unwrapRemoteVaultKeyWithPassword(password, wrapper.envelope);
    } catch (error) {
      if (isOperationError(error)) {
        throw new RemoteVaultPasswordChangedError();
      }
      throw error;
    }
    const keyFingerprint = await computeVaultKeyFingerprint(remoteVaultKey);
    const serverFingerprint = bootstrap.vault.keyFingerprint ?? null;
    if (serverFingerprint === null) {
      console.log(
        `[osync] vault key: vault ${bootstrap.vault.id} has no recorded key fingerprint; connecting unverified`,
      );
    } else if (serverFingerprint !== keyFingerprint) {
      throw new Error(
        "The key unwrapped with this password does not match the vault's key fingerprint. Contact the vault owner.",
      );
    }
    const summary: RemoteVaultSessionSummary = {
      vaultId: bootstrap.vault.id,
      vaultName: bootstrap.vault.name,
      activeKeyVersion: bootstrap.vault.activeKeyVersion,
      bootstrappedAt: new Date().toISOString(),
    };

    this.session = {
      summary,
      remoteVaultKey,
      keyFingerprint,
    };
    await this.deps.saveStoredRemoteVaultKeySecret({
      vaultId: summary.vaultId,
      remoteVaultKey,
      fingerprint: keyFingerprint,
    });
    this.deps.saveCachedRemoteVaultSummary?.({
      vaultId: summary.vaultId,
      vaultName: summary.vaultName,
      activeKeyVersion: summary.activeKeyVersion,
      keyFingerprint: serverFingerprint,
    });
    this.deps.refreshUi();
  }

  private ensureAuthenticated(): void {
    if (!this.deps.hasAuthenticatedSession()) {
      throw new Error("Sign in before managing a vault.");
    }
  }

  private notify(message: string): void {
    this.deps.notify(message);
  }

  private requireSession(): RemoteVaultSession {
    if (!this.session) {
      throw new Error("Vault session is not loaded.");
    }

    return this.session;
  }
}

function validateCreateInput(input: CreateRemoteVaultInput): void {
  if (!input.name.trim()) {
    throw new Error("Vault name is required.");
  }

  const passwordValidation = validateVaultPassword(input.password);
  if (!passwordValidation.ok) {
    throw new Error(passwordValidation.message);
  }

  if (input.password !== input.confirmPassword) {
    throw new Error("Passwords do not match.");
  }
}

function findPasswordWrapper(
  wrappers: RemoteVaultKeyWrapperRecord[],
): RemoteVaultKeyWrapperRecord {
  const wrapper =
    wrappers.find(
      (candidate) =>
        candidate.kind === "password" &&
        candidate.userId !== null &&
        candidate.revokedAt === null,
    ) ??
    wrappers.find(
      (candidate) => candidate.kind === "password" && candidate.revokedAt === null,
    );

  if (!wrapper) {
    throw new Error("No active password wrapper found for this vault.");
  }

  return wrapper;
}

function formatVaultLabel(vault: Pick<RemoteVaultSessionSummary, "vaultId" | "vaultName">): string {
  return `${vault.vaultName} (${vault.vaultId})`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function isOperationError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "OperationError";
  }
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "OperationError"
  );
}

function formatStoredVaultLabel(
  vault: string | RemoteVaultSessionSummary,
): string {
  if (typeof vault === "string") {
    return vault;
  }

  if (vault.vaultName) {
    return vault.vaultName;
  }

  return vault.vaultId;
}
