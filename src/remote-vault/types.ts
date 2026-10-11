export interface RemoteVaultKeyDerivationMetadata {
  name: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: string;
}

export interface RemoteVaultKeyWrapMetadata {
  algorithm: string;
  nonce: string;
  ciphertext: string;
}

export interface RemoteVaultKeyEnvelope {
  version: number;
  keyVersion: number;
  kdf: RemoteVaultKeyDerivationMetadata;
  wrap: RemoteVaultKeyWrapMetadata;
}

export interface RemoteVaultKeyWrapper {
  kind: "password" | "member" | "recovery";
  envelope: RemoteVaultKeyEnvelope;
}

export interface RemoteVaultRecord {
  id: string;
  organizationId: string;
  name: string;
  activeKeyVersion: number;
  // SHA-256 (base64) of the vault key, recorded at creation. null for vaults that
  // predate fingerprint recording; absent from servers older than 2.5.1.
  keyFingerprint?: string | null;
  createdAt: string;
}

export interface RemoteVaultKeyWrapperRecord {
  id: string;
  vaultId: string;
  keyVersion: number;
  kind: "password" | "member" | "recovery";
  userId: string | null;
  envelope: RemoteVaultKeyEnvelope;
  createdAt: string;
  revokedAt: string | null;
}

export interface RemoteVaultBootstrapResponse {
  vault: RemoteVaultRecord;
  wrappers: RemoteVaultKeyWrapperRecord[];
}

export interface RemoteVaultSummaryResponse {
  vaults: RemoteVaultRecord[];
}

export interface CreateRemoteVaultResponse {
  vault: RemoteVaultRecord;
}

export interface RemoteVaultSessionSummary {
  vaultId: string;
  vaultName: string;
  activeKeyVersion: number;
  bootstrappedAt: string | null;
}

export interface RemoteVaultSession {
  summary: RemoteVaultSessionSummary;
  remoteVaultKey: Uint8Array;
  // computeVaultKeyFingerprint(remoteVaultKey), when already known.
  keyFingerprint?: string;
}

export interface CreateRemoteVaultRequest {
  name: string;
  keyFingerprint: string;
  initialWrapper: RemoteVaultKeyWrapper;
}

export interface ChangeVaultPasswordRequest {
  envelope: RemoteVaultKeyEnvelope;
  keyFingerprint: string;
}

export interface ChangeVaultPasswordResponse {
  wrapper: RemoteVaultKeyWrapperRecord;
}

export type RemoteVaultPasswordChangeRejectedCode =
  | "fingerprint_mismatch"
  | "fingerprint_unset"
  | "wrapper_not_found";

export class RemoteVaultPasswordIncorrectError extends Error {
  constructor(message = "Current vault password is incorrect.") {
    super(message);
    this.name = "RemoteVaultPasswordIncorrectError";
  }
}

export class RemoteVaultPasswordChangeRejectedError extends Error {
  constructor(
    public readonly code: RemoteVaultPasswordChangeRejectedCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteVaultPasswordChangeRejectedError";
  }
}

export class RemoteVaultPasswordChangedError extends Error {
  constructor(
    message =
      "The vault password may have changed on another device. Please enter the current password.",
  ) {
    super(message);
    this.name = "RemoteVaultPasswordChangedError";
  }
}

export const VAULT_KEY_MISMATCH_NOTICE =
  "Osync: the saved key for this vault doesn't match. Re-enter the vault password.";

// The key this device holds for a vault is not that vault's key (its fingerprint
// differs from the one the server recorded). Syncing with it would upload entries no
// other device can decrypt, so the session is refused until the password is re-entered.
export class RemoteVaultKeyMismatchError extends Error {
  constructor(
    public readonly vaultId: string,
    message = "The vault key on this device does not match this vault. Re-enter the vault password.",
  ) {
    super(message);
    this.name = "RemoteVaultKeyMismatchError";
  }
}
