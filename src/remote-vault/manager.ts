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
  RemoteVaultPasswordChangedError,
  RemoteVaultPasswordIncorrectError,
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
  remoteVaultClient?: RemoteVaultClient;
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

    const bootstrap = await this.remoteVaultClient.getRemoteVaultBootstrap(
      this.deps.getApiBaseUrl(),
      this.deps.getAuthSessionToken(),
      remoteVaultId,
    );

    this.session = {
      summary: {
        vaultId: bootstrap.vault.id,
        vaultName: bootstrap.vault.name,
        activeKeyVersion: bootstrap.vault.activeKeyVersion,
        bootstrappedAt: new Date().toISOString(),
      },
      remoteVaultKey: storedVaultKey.remoteVaultKey,
    };
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
    const summary: RemoteVaultSessionSummary = {
      vaultId: bootstrap.vault.id,
      vaultName: bootstrap.vault.name,
      activeKeyVersion: bootstrap.vault.activeKeyVersion,
      bootstrappedAt: new Date().toISOString(),
    };

    this.session = {
      summary,
      remoteVaultKey,
    };
    await this.deps.saveStoredRemoteVaultKeySecret({
      remoteVaultKey,
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
