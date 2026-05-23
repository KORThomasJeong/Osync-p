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
