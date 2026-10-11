import type { PluginDataStoreLike } from "../plugin-data";

const CACHED_REMOTE_VAULT_SUMMARY_KEY = "cachedRemoteVaultSummary";

export interface CachedRemoteVaultSummary {
  vaultId: string;
  vaultName: string;
  activeKeyVersion: number;
  // The server's recorded key fingerprint for vaultId (null: unset on the server).
  // Lets a restart verify the stored key offline. Absent in caches before 2.5.1.
  keyFingerprint?: string | null;
}

export function readCachedRemoteVaultSummary(
  store: PluginDataStoreLike,
): CachedRemoteVaultSummary | null {
  const raw = store.read<unknown>(CACHED_REMOTE_VAULT_SUMMARY_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const { vaultId, vaultName, activeKeyVersion } = candidate;
  if (
    typeof vaultId !== "string" ||
    typeof vaultName !== "string" ||
    typeof activeKeyVersion !== "number" ||
    !Number.isFinite(activeKeyVersion)
  ) {
    return null;
  }

  const keyFingerprint = candidate.keyFingerprint;
  return {
    vaultId,
    vaultName,
    activeKeyVersion,
    ...(typeof keyFingerprint === "string" || keyFingerprint === null ? { keyFingerprint } : {}),
  };
}

export function writeCachedRemoteVaultSummary(
  store: PluginDataStoreLike,
  summary: CachedRemoteVaultSummary,
): void {
  store.write(CACHED_REMOTE_VAULT_SUMMARY_KEY, {
    vaultId: summary.vaultId,
    vaultName: summary.vaultName,
    activeKeyVersion: summary.activeKeyVersion,
    ...(summary.keyFingerprint !== undefined ? { keyFingerprint: summary.keyFingerprint } : {}),
  });
}
