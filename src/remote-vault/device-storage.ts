import type { Plugin } from "obsidian";

import { decodeBase64, encodeBase64 } from "../utils/bytes";
import { computeVaultKeyFingerprint } from "./crypto";

// Obsidian's secretStorage (Keychain on iOS/macOS) is app-wide: every local vault on
// the device sees the same secrets. Plugins up to 2.5.0 stored the vault key under one
// fixed id, so two local vaults connected to two different remote vaults overwrote each
// other's key and one of them silently encrypted with the other vault's key. Keys are
// now stored per remote vault and bound to that vault id.
export const LEGACY_REMOTE_VAULT_KEY_SECRET = "osync-remote-vault-key";
const REMOTE_VAULT_KEY_SECRET_PREFIX = "osync-remote-vault-key-";
const STORED_SECRET_VERSION = 1;

export interface StoredRemoteVaultKeySecret {
  remoteVaultKey: Uint8Array;
  // The remote vault this key belongs to. Absent only for the legacy (shared,
  // unbound) secret, which must be verified against the vault's fingerprint before use.
  vaultId?: string;
  // computeVaultKeyFingerprint(remoteVaultKey).
  fingerprint?: string;
}

export interface BoundRemoteVaultKeySecret extends StoredRemoteVaultKeySecret {
  vaultId: string;
  fingerprint: string;
}

// Secret ids must be lowercase alphanumeric with dashes.
export function remoteVaultKeySecretId(vaultId: string): string {
  const normalized = vaultId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${REMOTE_VAULT_KEY_SECRET_PREFIX}${normalized}`;
}

export async function readStoredRemoteVaultKeySecret(
  plugin: Plugin,
  vaultId: string,
): Promise<BoundRemoteVaultKeySecret | null> {
  const raw = plugin.app.secretStorage.getSecret(remoteVaultKeySecretId(vaultId))?.trim() ?? "";
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.v !== STORED_SECRET_VERSION ||
      parsed.vaultId !== vaultId ||
      typeof parsed.key !== "string" ||
      typeof parsed.fingerprint !== "string"
    ) {
      return null;
    }
    const remoteVaultKey = decodeBase64(parsed.key);
    // Integrity: a value whose key does not hash to its recorded fingerprint is corrupt.
    if ((await computeVaultKeyFingerprint(remoteVaultKey)) !== parsed.fingerprint) {
      return null;
    }
    return { vaultId, remoteVaultKey, fingerprint: parsed.fingerprint };
  } catch {
    return null;
  }
}

export async function writeStoredRemoteVaultKeySecret(
  plugin: Plugin,
  secret: StoredRemoteVaultKeySecret & { vaultId: string },
): Promise<void> {
  const fingerprint =
    secret.fingerprint ?? (await computeVaultKeyFingerprint(secret.remoteVaultKey));
  plugin.app.secretStorage.setSecret(
    remoteVaultKeySecretId(secret.vaultId),
    JSON.stringify({
      v: STORED_SECRET_VERSION,
      vaultId: secret.vaultId,
      key: encodeBase64(secret.remoteVaultKey),
      fingerprint,
    }),
  );
}

export async function clearStoredRemoteVaultKeySecret(
  plugin: Plugin,
  vaultId: string,
): Promise<void> {
  plugin.app.secretStorage.setSecret(remoteVaultKeySecretId(vaultId), "");
}

// The pre-2.5.1 shared secret. It is never trusted on its own: callers adopt it for a
// vault only when its fingerprint matches that vault's recorded fingerprint.
export async function readLegacyRemoteVaultKeySecret(
  plugin: Plugin,
): Promise<StoredRemoteVaultKeySecret | null> {
  const raw = plugin.app.secretStorage.getSecret(LEGACY_REMOTE_VAULT_KEY_SECRET)?.trim() ?? "";
  if (!raw) {
    return null;
  }

  try {
    return { remoteVaultKey: decodeBase64(raw) };
  } catch {
    return null;
  }
}

export async function clearLegacyRemoteVaultKeySecret(plugin: Plugin): Promise<void> {
  plugin.app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, "");
}

// This vault's own key if one is stored for it; otherwise the legacy shared key, which
// the caller must verify against the vault's fingerprint before adopting it.
export async function readRemoteVaultKeySecretForVault(
  plugin: Plugin,
  vaultId: string,
): Promise<StoredRemoteVaultKeySecret | null> {
  return (
    (await readStoredRemoteVaultKeySecret(plugin, vaultId)) ??
    (await readLegacyRemoteVaultKeySecret(plugin))
  );
}

// Removes the vault's key from this device (disconnect, sign-out, or a key found not
// to match). Only this vault's slot is cleared. The legacy shared secret is left for
// other local vaults that may still need to migrate from it, except when it holds
// this vault's own verified key — a disconnect must not leave that behind.
export async function releaseRemoteVaultKeySecret(
  plugin: Plugin,
  vaultId: string,
  released: StoredRemoteVaultKeySecret | null,
): Promise<void> {
  await clearStoredRemoteVaultKeySecret(plugin, vaultId);
  if (!released || released.vaultId !== vaultId) {
    // Unverified (legacy) or someone else's key: never delete the shared secret.
    return;
  }
  const legacy = await readLegacyRemoteVaultKeySecret(plugin);
  if (legacy && bytesEqual(legacy.remoteVaultKey, released.remoteVaultKey)) {
    await clearLegacyRemoteVaultKeySecret(plugin);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
