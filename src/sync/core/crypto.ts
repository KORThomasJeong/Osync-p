import type { SyncedEntryMetadata } from "./content";
import { parseSyncedEntryMetadata, serializeSyncedEntryMetadata } from "./content";
import { decodeBase64, encodeBase64, randomBytes, toArrayBuffer } from "../../utils/bytes";

const ENVELOPE_VERSION = 1;
const AES_GCM_NONCE_BYTES = 12;
const KEY_USAGE_SALT = new Uint8Array();

export type SyncMetadataCryptoContext = {
  entryId: string;
  revision: number;
  op: "upsert" | "delete";
  blobId: string | null;
};

export type SyncBlobCryptoContext = {
  blobId: string;
};

type EncryptedEnvelope = {
  version: number;
  nonce: string;
  ciphertext: string;
};

export async function encryptSyncMetadata(
  remoteVaultKey: Uint8Array,
  metadata: SyncedEntryMetadata,
  context: SyncMetadataCryptoContext,
): Promise<string> {
  return await encryptEnvelope(
    remoteVaultKey,
    "sync-metadata",
    new TextEncoder().encode(serializeSyncedEntryMetadata(metadata)),
    encodeMetadataAad(context),
  );
}

export async function decryptSyncMetadata(
  remoteVaultKey: Uint8Array,
  encryptedMetadata: string,
  context: SyncMetadataCryptoContext,
): Promise<SyncedEntryMetadata> {
  const plaintext = await decryptEnvelope(
    remoteVaultKey,
    "sync-metadata",
    encryptedMetadata,
    encodeMetadataAad(context),
  );
  return parseSyncedEntryMetadata(new TextDecoder().decode(plaintext));
}

export async function encryptSyncBlob(
  remoteVaultKey: Uint8Array,
  plaintext: Uint8Array,
  context: SyncBlobCryptoContext,
): Promise<Uint8Array> {
  const envelope = await encryptEnvelope(
    remoteVaultKey,
    "sync-blob",
    plaintext,
    encodeBlobAad(context),
  );
  return new TextEncoder().encode(envelope);
}

export async function derivePathToken(
  vaultKey: Uint8Array,
  path: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(vaultKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`path-token:v1:${path}`),
  );
  const bytes = new Uint8Array(signature).slice(0, 16);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function decryptSyncBlob(
  remoteVaultKey: Uint8Array,
  encryptedBlob: Uint8Array,
  context: SyncBlobCryptoContext,
): Promise<Uint8Array> {
  return await decryptEnvelope(
    remoteVaultKey,
    "sync-blob",
    new TextDecoder().decode(encryptedBlob),
    encodeBlobAad(context),
  );
}

async function encryptEnvelope(
  remoteVaultKey: Uint8Array,
  usage: string,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<string> {
  const key = await deriveUsageKey(remoteVaultKey, usage);
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(additionalData),
    },
    key,
    toArrayBuffer(plaintext),
  );

  return JSON.stringify({
    version: ENVELOPE_VERSION,
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  } satisfies EncryptedEnvelope);
}

async function decryptEnvelope(
  remoteVaultKey: Uint8Array,
  usage: string,
  serializedEnvelope: string,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const envelope = parseEncryptedEnvelope(serializedEnvelope);
  const key = await deriveUsageKey(remoteVaultKey, usage);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(decodeBase64(envelope.nonce)),
      additionalData: toArrayBuffer(additionalData),
    },
    key,
    toArrayBuffer(decodeBase64(envelope.ciphertext)),
  );

  return new Uint8Array(plaintext);
}

async function deriveUsageKey(remoteVaultKey: Uint8Array, usage: string): Promise<CryptoKey> {
  const imported = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(remoteVaultKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(KEY_USAGE_SALT),
      info: new TextEncoder().encode(`${usage}:v${ENVELOPE_VERSION}`),
    },
    imported,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

function encodeMetadataAad(context: SyncMetadataCryptoContext): Uint8Array {
  return new TextEncoder().encode(
    [
      "synch.sync-metadata",
      `v${ENVELOPE_VERSION}`,
      context.entryId,
      String(context.revision),
      context.op,
      context.blobId ?? "",
    ].join("\n"),
  );
}

function encodeBlobAad(context: SyncBlobCryptoContext): Uint8Array {
  return new TextEncoder().encode(
    ["synch.sync-blob", `v${ENVELOPE_VERSION}`, context.blobId].join("\n"),
  );
}

function parseEncryptedEnvelope(value: string): EncryptedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Encrypted sync payload is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Encrypted sync payload must decode to an object.");
  }

  const record = parsed as Partial<EncryptedEnvelope>;
  if (record.version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported sync payload version: ${record.version ?? "unknown"}.`);
  }
  if (typeof record.nonce !== "string" || !record.nonce.trim()) {
    throw new Error("Encrypted sync payload is missing a nonce.");
  }
  if (typeof record.ciphertext !== "string" || !record.ciphertext.trim()) {
    throw new Error("Encrypted sync payload is missing ciphertext.");
  }

  return {
    version: record.version,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
  };
}
