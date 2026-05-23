import type { RemoteVaultKeyEnvelope } from "./types";
import { createArgon2idMetadata, deriveWrapKey } from "./kdf";
import { decodeBase64, encodeBase64, randomBytes, toArrayBuffer } from "../utils/bytes";

const WRAP_ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const KEY_VERSION = 1;
const VAULT_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;

export interface PasswordWrapperOptions {
  kdfOverrides?: Partial<{
    memoryKiB: number;
    iterations: number;
    parallelism: number;
  }>;
}

export interface CreatePasswordWrapperResult {
  envelope: RemoteVaultKeyEnvelope;
  remoteVaultKey: Uint8Array;
}

/** For vault creation only — never call to update an existing vault's wrapper. */
export async function createPasswordWrappedRemoteVaultKey(
  password: string,
  options: PasswordWrapperOptions = {},
): Promise<CreatePasswordWrapperResult> {
  const trimmedPassword = normalizePassword(password);
  const remoteVaultKey = randomBytes(VAULT_KEY_BYTES);
  const kdf = createArgon2idMetadata(options.kdfOverrides);
  const wrapKey = await deriveWrapKey(trimmedPassword, kdf);
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const ciphertext = await encryptRemoteVaultKey(wrapKey, remoteVaultKey, nonce);

  return {
    remoteVaultKey,
    envelope: {
      version: ENVELOPE_VERSION,
      keyVersion: KEY_VERSION,
      kdf,
      wrap: {
        algorithm: WRAP_ALGORITHM,
        nonce: encodeBase64(nonce),
        ciphertext: encodeBase64(ciphertext),
      },
    },
  };
}

export async function rewrapRemoteVaultKey(
  remoteVaultKey: Uint8Array,
  password: string,
  options: PasswordWrapperOptions = {},
): Promise<RemoteVaultKeyEnvelope> {
  if (remoteVaultKey.byteLength !== VAULT_KEY_BYTES) {
    throw new Error(`rewrapRemoteVaultKey requires a ${VAULT_KEY_BYTES}-byte vault key`);
  }
  const trimmedPassword = normalizePassword(password);
  const kdf = createArgon2idMetadata(options.kdfOverrides);
  const wrapKey = await deriveWrapKey(trimmedPassword, kdf);
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const ciphertext = await encryptRemoteVaultKey(wrapKey, remoteVaultKey, nonce);
  return {
    version: ENVELOPE_VERSION,
    keyVersion: KEY_VERSION,
    kdf,
    wrap: {
      algorithm: WRAP_ALGORITHM,
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(ciphertext),
    },
  };
}

export async function computeVaultKeyFingerprint(remoteVaultKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(remoteVaultKey));
  return encodeBase64(new Uint8Array(digest));
}

export async function unwrapRemoteVaultKeyWithPassword(
  password: string,
  envelope: RemoteVaultKeyEnvelope,
): Promise<Uint8Array> {
  const trimmedPassword = normalizePassword(password);
  validateEnvelope(envelope);

  const salt = decodeBase64(envelope.kdf.salt);
  const nonce = decodeBase64(envelope.wrap.nonce);
  const ciphertext = decodeBase64(envelope.wrap.ciphertext);
  const wrapKey = await deriveWrapKey(trimmedPassword, {
    ...envelope.kdf,
    salt: encodeBase64(salt),
  });
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
    },
    wrapKey,
    toArrayBuffer(ciphertext),
  );

  return new Uint8Array(plaintext);
}

async function encryptRemoteVaultKey(
  wrapKey: CryptoKey,
  remoteVaultKey: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
    },
    wrapKey,
    toArrayBuffer(remoteVaultKey),
  );

  return new Uint8Array(ciphertext);
}

function validateEnvelope(envelope: RemoteVaultKeyEnvelope): void {
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`unsupported wrapper version: ${envelope.version}`);
  }

  if (envelope.wrap.algorithm !== WRAP_ALGORITHM) {
    throw new Error(`unsupported wrap algorithm: ${envelope.wrap.algorithm}`);
  }
}

function normalizePassword(password: string): string {
  if (!password) {
    throw new Error("Password is required.");
  }

  if (password !== password.trim()) {
    throw new Error("Password cannot start or end with spaces.");
  }

  return password;
}
