import type { Plugin } from "obsidian";

const LOCAL_VAULT_ID_KEY = "osync.localVaultId";
// Vault-scoped history of every localVaultId this vault has ever owned. Obsidian
// namespaces saveLocalStorage per vault, so this set is private to this vault and lets
// orphan cleanup delete only stores this vault created — never another vault's store
// that happens to share the desktop IndexedDB origin.
const OWNED_LOCAL_VAULT_IDS_KEY = "osync.ownedLocalVaultIds";

interface VaultLocalStorageLike {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

export function getOrCreateLocalVaultId(plugin: Plugin): string {
  const existing = readLocalVaultId(plugin);
  if (existing) {
    recordOwnedLocalVaultId(plugin, existing);
    return existing;
  }

  const created = crypto.randomUUID();
  writeVaultLocalStorage(plugin, LOCAL_VAULT_ID_KEY, created);
  recordOwnedLocalVaultId(plugin, created);
  return created;
}

export function readLocalVaultId(plugin: Plugin): string {
  return readString(plugin, LOCAL_VAULT_ID_KEY);
}

export function clearLocalVaultId(plugin: Plugin): void {
  writeVaultLocalStorage(plugin, LOCAL_VAULT_ID_KEY, null);
}

export function recordOwnedLocalVaultId(plugin: Plugin, localVaultId: string): void {
  const trimmed = localVaultId.trim();
  if (!trimmed) return;
  const owned = readOwnedSet(plugin);
  if (owned.has(trimmed)) return;
  owned.add(trimmed);
  writeVaultLocalStorage(plugin, OWNED_LOCAL_VAULT_IDS_KEY, [...owned]);
}

export function readOwnedLocalVaultIds(plugin: Plugin): string[] {
  return [...readOwnedSet(plugin)];
}

function readOwnedSet(plugin: Plugin): Set<string> {
  const raw = vaultLocalStorage(plugin).loadLocalStorage(OWNED_LOCAL_VAULT_IDS_KEY);
  const owned = new Set<string>();
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === "string" && value.trim()) owned.add(value.trim());
    }
  }
  // A vault that predates owned-set tracking still has its active localVaultId; treat it
  // as owned so its own stale stores remain collectible after this migration.
  const active = readLocalVaultId(plugin);
  if (active) owned.add(active);
  return owned;
}

function readString(plugin: Plugin, key: string): string {
  const value = vaultLocalStorage(plugin).loadLocalStorage(key);
  return typeof value === "string" ? value.trim() : "";
}

function writeVaultLocalStorage(plugin: Plugin, key: string, value: unknown): void {
  vaultLocalStorage(plugin).saveLocalStorage(key, value);
}

function vaultLocalStorage(plugin: Plugin): VaultLocalStorageLike {
  return plugin.app as unknown as VaultLocalStorageLike;
}
