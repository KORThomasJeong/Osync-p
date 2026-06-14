import { describe, expect, it, vi } from "vitest";

import type { StoredRemoteVaultKeySecret } from "../../device-storage";
import type { RemoteVaultBootstrapResponse } from "../../types";
import { createManager } from "./helpers";

describe("RemoteVaultManager offline restore", () => {
  it("still sets an active session when the bootstrap call rejects (offline)", async () => {
    const refreshUi = vi.fn();
    const storedVault: StoredRemoteVaultKeySecret = {
      remoteVaultKey: new Uint8Array([4, 5, 6]),
    };

    const manager = createManager({
      storedVaultId: "vault-offline",
      storedVault,
      refreshUi,
      getCachedRemoteVaultSummary: () => ({
        vaultName: "Cached Name",
        activeKeyVersion: 3,
      }),
      remoteVaultClient: {
        getRemoteVaultBootstrap: async (): Promise<RemoteVaultBootstrapResponse> => {
          throw new Error("network offline");
        },
      },
    });

    await expect(manager.restorePersistedRemoteVaultSession()).resolves.toBeUndefined();

    // Let the fire-and-forget background refresh settle (and reject).
    await Promise.resolve();
    await Promise.resolve();

    const session = manager.getActiveSession();
    expect(session).not.toBeNull();
    expect(manager.getRemoteVaultId()).toBe("vault-offline");
    expect(session?.summary.vaultName).toBe("Cached Name");
    expect(session?.summary.activeKeyVersion).toBe(3);
    expect(session?.remoteVaultKey).toEqual(storedVault.remoteVaultKey);
    expect(refreshUi).toHaveBeenCalled();
  });

  it("falls back to a placeholder summary when no cache is present and offline", async () => {
    const storedVault: StoredRemoteVaultKeySecret = {
      remoteVaultKey: new Uint8Array([1, 1, 1]),
    };

    const manager = createManager({
      storedVaultId: "vault-no-cache",
      storedVault,
      remoteVaultClient: {
        getRemoteVaultBootstrap: async (): Promise<RemoteVaultBootstrapResponse> => {
          throw new Error("network offline");
        },
      },
    });

    await manager.restorePersistedRemoteVaultSession();
    await Promise.resolve();
    await Promise.resolve();

    const session = manager.getActiveSession();
    expect(session).not.toBeNull();
    expect(session?.summary.vaultId).toBe("vault-no-cache");
    expect(session?.summary.vaultName).toBe("vault-no-cache");
    expect(session?.summary.activeKeyVersion).toBe(1);
  });

  it("updates the summary and persists the cache when bootstrap later resolves", async () => {
    const refreshUi = vi.fn();
    const saveCachedRemoteVaultSummary = vi.fn();
    const storedVault: StoredRemoteVaultKeySecret = {
      remoteVaultKey: new Uint8Array([7, 8, 9]),
    };

    let resolveBootstrap: ((value: RemoteVaultBootstrapResponse) => void) | null =
      null;
    const bootstrapPromise = new Promise<RemoteVaultBootstrapResponse>((resolve) => {
      resolveBootstrap = resolve;
    });

    const manager = createManager({
      storedVaultId: "vault-online",
      storedVault,
      refreshUi,
      saveCachedRemoteVaultSummary,
      getCachedRemoteVaultSummary: () => null,
      remoteVaultClient: {
        getRemoteVaultBootstrap: () => bootstrapPromise,
      },
    });

    await manager.restorePersistedRemoteVaultSession();

    // Session is active immediately with the placeholder summary.
    expect(manager.getActiveSession()?.summary.vaultName).toBe("vault-online");
    expect(saveCachedRemoteVaultSummary).not.toHaveBeenCalled();

    // Bootstrap completes in the background and the summary is refreshed.
    resolveBootstrap?.({
      vault: {
        id: "vault-online",
        name: "Fresh Name",
        activeKeyVersion: 5,
        createdAt: "2026-04-22T00:00:00.000Z",
        organizationId: "org-1",
      },
      wrappers: [],
    });
    await bootstrapPromise;
    await Promise.resolve();

    const session = manager.getActiveSession();
    expect(session?.summary.vaultName).toBe("Fresh Name");
    expect(session?.summary.activeKeyVersion).toBe(5);
    expect(saveCachedRemoteVaultSummary).toHaveBeenCalledWith({
      vaultId: "vault-online",
      vaultName: "Fresh Name",
      activeKeyVersion: 5,
    });
  });

  it("does not overwrite a session that was cleared before bootstrap resolves", async () => {
    const saveCachedRemoteVaultSummary = vi.fn();
    const storedVault: StoredRemoteVaultKeySecret = {
      remoteVaultKey: new Uint8Array([2, 2, 2]),
    };

    let resolveBootstrap: ((value: RemoteVaultBootstrapResponse) => void) | null =
      null;
    const bootstrapPromise = new Promise<RemoteVaultBootstrapResponse>((resolve) => {
      resolveBootstrap = resolve;
    });

    const manager = createManager({
      storedVaultId: "vault-cleared",
      storedVault,
      saveCachedRemoteVaultSummary,
      remoteVaultClient: {
        getRemoteVaultBootstrap: () => bootstrapPromise,
      },
    });

    await manager.restorePersistedRemoteVaultSession();
    manager.clearSession();

    resolveBootstrap?.({
      vault: {
        id: "vault-cleared",
        name: "Should Not Apply",
        activeKeyVersion: 9,
        createdAt: "2026-04-22T00:00:00.000Z",
        organizationId: "org-1",
      },
      wrappers: [],
    });
    await bootstrapPromise;
    await Promise.resolve();

    expect(manager.getActiveSession()).toBeNull();
    expect(saveCachedRemoteVaultSummary).not.toHaveBeenCalled();
  });
});
