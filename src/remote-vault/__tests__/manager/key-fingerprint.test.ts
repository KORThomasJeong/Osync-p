import { describe, expect, it, vi } from "vitest";

import {
  computeVaultKeyFingerprint,
  createPasswordWrappedRemoteVaultKey,
} from "../../crypto";
import type { StoredRemoteVaultKeySecret } from "../../device-storage";
import {
  RemoteVaultKeyMismatchError,
  type RemoteVaultBootstrapResponse,
} from "../../types";
import { createManager, remoteVaultSummary } from "./helpers";

// Regression for the multi-vault iPhone bug: secretStorage is app-wide, so the key a
// local vault finds may belong to another remote vault. A key must never be trusted
// for vault X unless its fingerprint matches X's recorded fingerprint.

const VAULT_A = "vault-a";
const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);

function bootstrapWith(keyFingerprint: string | null | undefined) {
  return async (): Promise<RemoteVaultBootstrapResponse> => ({
    vault: { ...remoteVaultSummary({ id: VAULT_A, name: "A" }), keyFingerprint },
    wrappers: [],
  });
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("RemoteVaultManager key fingerprint verification", () => {
  it("adopts the legacy shared key when it matches the server fingerprint and rebinds it per vault", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const fpA = await computeVaultKeyFingerprint(KEY_A);
    const manager = createManager({
      storedVaultId: VAULT_A,
      storedVault: { remoteVaultKey: KEY_A },
      savedVaults,
      remoteVaultClient: { getRemoteVaultBootstrap: bootstrapWith(fpA) },
    });

    await manager.restorePersistedRemoteVaultSession();

    expect(manager.getActiveSession()?.remoteVaultKey).toEqual(KEY_A);
    expect(savedVaults.at(-1)).toEqual({ vaultId: VAULT_A, remoteVaultKey: KEY_A, fingerprint: fpA });
  });

  it("refuses the legacy shared key when it belongs to another vault", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const notify = vi.fn();
    const manager = createManager({
      storedVaultId: VAULT_A,
      storedVault: { remoteVaultKey: KEY_B },
      savedVaults,
      notify,
      remoteVaultClient: {
        getRemoteVaultBootstrap: bootstrapWith(await computeVaultKeyFingerprint(KEY_A)),
      },
    });

    await expect(manager.restorePersistedRemoteVaultSession()).rejects.toBeInstanceOf(
      RemoteVaultKeyMismatchError,
    );

    expect(manager.getActiveSession()).toBeNull();
    expect(savedVaults.at(-1)).toBeNull();
    expect(notify).toHaveBeenCalledWith(
      "Osync: the saved key for this vault doesn't match. Re-enter the vault password.",
    );
  });

  it("does not adopt the legacy key offline without a cached fingerprint", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const manager = createManager({
      storedVaultId: VAULT_A,
      storedVault: { remoteVaultKey: KEY_A },
      savedVaults,
      getCachedRemoteVaultSummary: () => ({ vaultId: VAULT_A, vaultName: "A", activeKeyVersion: 1 }),
      remoteVaultClient: {
        getRemoteVaultBootstrap: async () => {
          throw new Error("network offline");
        },
      },
    });

    await manager.restorePersistedRemoteVaultSession();

    expect(manager.getActiveSession()).toBeNull();
    expect(savedVaults).toEqual([]);
  });

  it("adopts the legacy key offline when the cached fingerprint for this vault matches", async () => {
    const fpA = await computeVaultKeyFingerprint(KEY_A);
    const manager = createManager({
      storedVaultId: VAULT_A,
      storedVault: { remoteVaultKey: KEY_A },
      getCachedRemoteVaultSummary: () => ({
        vaultId: VAULT_A,
        vaultName: "A",
        activeKeyVersion: 1,
        keyFingerprint: fpA,
      }),
      remoteVaultClient: {
        getRemoteVaultBootstrap: async () => {
          throw new Error("network offline");
        },
      },
    });

    await manager.restorePersistedRemoteVaultSession();

    expect(manager.getActiveSession()?.remoteVaultKey).toEqual(KEY_A);
  });

  it("ignores a cached fingerprint recorded for a different vault", async () => {
    const manager = createManager({
      storedVaultId: VAULT_A,
      storedVault: { remoteVaultKey: KEY_B },
      getCachedRemoteVaultSummary: () => ({
        vaultId: "vault-b",
        vaultName: "B",
        activeKeyVersion: 1,
        keyFingerprint: "fp-of-b",
      }),
      remoteVaultClient: {
        getRemoteVaultBootstrap: async () => {
          throw new Error("network offline");
        },
      },
    });

    await manager.restorePersistedRemoteVaultSession();

    expect(manager.getActiveSession()).toBeNull();
  });

  it("rejects a per-vault key that contradicts the cached fingerprint before activating", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const manager = createManager({
      storedVaultId: VAULT_A,
      storedVault: {
        vaultId: VAULT_A,
        remoteVaultKey: KEY_B,
        fingerprint: await computeVaultKeyFingerprint(KEY_B),
      },
      savedVaults,
      getCachedRemoteVaultSummary: () => ({
        vaultId: VAULT_A,
        vaultName: "A",
        activeKeyVersion: 1,
        keyFingerprint: "fingerprint-of-a",
      }),
    });

    await expect(manager.restorePersistedRemoteVaultSession()).rejects.toBeInstanceOf(
      RemoteVaultKeyMismatchError,
    );
    expect(manager.getActiveSession()).toBeNull();
    expect(savedVaults.at(-1)).toBeNull();
  });

  it("deactivates a restored session when the server fingerprint disagrees", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const onStoredKeyMismatch = vi.fn();
    const manager = createManager({
      storedVaultId: VAULT_A,
      storedVault: {
        vaultId: VAULT_A,
        remoteVaultKey: KEY_B,
        fingerprint: await computeVaultKeyFingerprint(KEY_B),
      },
      savedVaults,
      onStoredKeyMismatch,
      remoteVaultClient: {
        getRemoteVaultBootstrap: bootstrapWith(await computeVaultKeyFingerprint(KEY_A)),
      },
    });

    await manager.restorePersistedRemoteVaultSession();
    await flush();

    expect(manager.getActiveSession()).toBeNull();
    expect(savedVaults.at(-1)).toBeNull();
    expect(onStoredKeyMismatch).toHaveBeenCalledWith(VAULT_A);
  });

  it("keeps the session and caches the fingerprint when the server agrees", async () => {
    const fpA = await computeVaultKeyFingerprint(KEY_A);
    const saveCachedRemoteVaultSummary = vi.fn();
    const manager = createManager({
      storedVaultId: VAULT_A,
      storedVault: { vaultId: VAULT_A, remoteVaultKey: KEY_A, fingerprint: fpA },
      saveCachedRemoteVaultSummary,
      remoteVaultClient: { getRemoteVaultBootstrap: bootstrapWith(fpA) },
    });

    await manager.restorePersistedRemoteVaultSession();
    await flush();

    expect(manager.getActiveSession()?.remoteVaultKey).toEqual(KEY_A);
    expect(saveCachedRemoteVaultSummary).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: VAULT_A, keyFingerprint: fpA }),
    );
  });

  it("allows (and logs) a vault whose server fingerprint is unset", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const manager = createManager({
        storedVaultId: VAULT_A,
        storedVault: { remoteVaultKey: KEY_B },
        remoteVaultClient: { getRemoteVaultBootstrap: bootstrapWith(null) },
      });

      await manager.restorePersistedRemoteVaultSession();

      expect(manager.getActiveSession()?.remoteVaultKey).toEqual(KEY_B);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("stores the connected key per vault with its fingerprint and caches the server fingerprint", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const saveCachedRemoteVaultSummary = vi.fn();
    const wrapped = await createPasswordWrappedRemoteVaultKey("vault-password", {
      kdfOverrides: { memoryKiB: 8, iterations: 1, parallelism: 1 },
    });
    const fp = await computeVaultKeyFingerprint(wrapped.remoteVaultKey);
    const manager = createManager({
      savedVaults,
      saveCachedRemoteVaultSummary,
      remoteVaultClient: {
        getRemoteVaultBootstrap: async (): Promise<RemoteVaultBootstrapResponse> => ({
          vault: { ...remoteVaultSummary({ id: VAULT_A, name: "A" }), keyFingerprint: fp },
          wrappers: [
            {
              id: "w",
              vaultId: VAULT_A,
              keyVersion: 1,
              kind: "password",
              userId: "u",
              envelope: wrapped.envelope,
              createdAt: "2026-04-22T00:00:00.000Z",
              revokedAt: null,
            },
          ],
        }),
      },
    });

    await manager.bootstrapRemoteVault({ vaultId: VAULT_A, password: "vault-password", initialSyncMode: "merge" });

    expect(savedVaults.at(-1)).toEqual({ vaultId: VAULT_A, remoteVaultKey: wrapped.remoteVaultKey, fingerprint: fp });
    expect(saveCachedRemoteVaultSummary).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: VAULT_A, keyFingerprint: fp }),
    );
    expect(await manager.getActiveKeyFingerprint()).toBe(fp);
  });

  it("refuses to connect when the unwrapped key does not match the vault fingerprint", async () => {
    const wrapped = await createPasswordWrappedRemoteVaultKey("vault-password", {
      kdfOverrides: { memoryKiB: 8, iterations: 1, parallelism: 1 },
    });
    const manager = createManager({
      remoteVaultClient: {
        getRemoteVaultBootstrap: async (): Promise<RemoteVaultBootstrapResponse> => ({
          vault: { ...remoteVaultSummary({ id: VAULT_A }), keyFingerprint: "someone-else" },
          wrappers: [
            {
              id: "w",
              vaultId: VAULT_A,
              keyVersion: 1,
              kind: "password",
              userId: "u",
              envelope: wrapped.envelope,
              createdAt: "2026-04-22T00:00:00.000Z",
              revokedAt: null,
            },
          ],
        }),
      },
    });

    await expect(
      manager.bootstrapRemoteVault({ vaultId: VAULT_A, password: "vault-password", initialSyncMode: "merge" }),
    ).rejects.toThrow(/fingerprint/);
    expect(manager.getActiveSession()).toBeNull();
  });
});
