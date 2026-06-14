import type { PluginDataStoreLike } from "../plugin-data";

const CACHED_REMOTE_VAULT_SUMMARY_KEY = "cachedRemoteVaultSummary";

export interface CachedRemoteVaultSummary {
  vaultId: string;
  vaultName: string;
  activeKeyVersion: number;
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

  return { vaultId, vaultName, activeKeyVersion };
}

export function writeCachedRemoteVaultSummary(
  store: PluginDataStoreLike,
  summary: CachedRemoteVaultSummary,
): void {
  store.write(CACHED_REMOTE_VAULT_SUMMARY_KEY, {
    vaultId: summary.vaultId,
    vaultName: summary.vaultName,
    activeKeyVersion: summary.activeKeyVersion,
  });
}
