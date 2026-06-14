import { vi } from "vitest";

import type { StoredRemoteVaultKeySecret } from "../../device-storage";
import { RemoteVaultManager } from "../../manager";
import type {
  ChangeVaultPasswordRequest,
  CreateRemoteVaultResponse,
  RemoteVaultBootstrapResponse,
  RemoteVaultKeyWrapperRecord,
  RemoteVaultSummaryResponse,
} from "../../types";

type RemoteVaultClientOverrides = Partial<{
  createRemoteVault: (
    apiBaseUrl: string,
    sessionToken: string,
    input: unknown,
  ) => Promise<CreateRemoteVaultResponse>;
  getRemoteVaultBootstrap: (
    apiBaseUrl: string,
    sessionToken: string,
    vaultId: string,
  ) => Promise<RemoteVaultBootstrapResponse>;
  listRemoteVaults: (
    apiBaseUrl: string,
    sessionToken: string,
  ) => Promise<RemoteVaultSummaryResponse>;
  changeVaultPassword: (
    apiBaseUrl: string,
    sessionToken: string,
    vaultId: string,
    payload: ChangeVaultPasswordRequest,
  ) => Promise<RemoteVaultKeyWrapperRecord>;
}>;

export function createManager(input: {
  storedVaultId?: string | null;
  storedVault?: StoredRemoteVaultKeySecret | null;
  savedVaults?: Array<StoredRemoteVaultKeySecret | null>;
  refreshUi?: () => void;
  notify?: (message: string) => void;
  getCachedRemoteVaultSummary?: () => {
    vaultName: string;
    activeKeyVersion: number;
  } | null;
  saveCachedRemoteVaultSummary?: (summary: {
    vaultId: string;
    vaultName: string;
    activeKeyVersion: number;
  }) => void;
  remoteVaultClient?: RemoteVaultClientOverrides;
}) {
  return new RemoteVaultManager({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getAuthSessionToken: () => "session-token",
    hasAuthenticatedSession: () => true,
    getStoredRemoteVaultId: () => input.storedVaultId ?? null,
    getStoredRemoteVaultKeySecret: () => input.storedVault ?? null,
    saveStoredRemoteVaultKeySecret: async (vault) => {
      input.savedVaults?.push(vault);
    },
    refreshUi: input.refreshUi ?? vi.fn(),
    notify: input.notify ?? vi.fn(),
    getCachedRemoteVaultSummary: input.getCachedRemoteVaultSummary,
    saveCachedRemoteVaultSummary: input.saveCachedRemoteVaultSummary,
    remoteVaultClient: {
      createRemoteVault:
        input.remoteVaultClient?.createRemoteVault ??
        (async () => {
          throw new Error("createRemoteVault should not be called");
        }),
      getRemoteVaultBootstrap:
        input.remoteVaultClient?.getRemoteVaultBootstrap ??
        (async () => {
          throw new Error("getRemoteVaultBootstrap should not be called");
        }),
      listRemoteVaults:
        input.remoteVaultClient?.listRemoteVaults ??
        (async () => ({
          vaults: [],
        })),
      changeVaultPassword:
        input.remoteVaultClient?.changeVaultPassword ??
        (async () => {
          throw new Error("changeVaultPassword should not be called");
        }),
    } as never,
  });
}

export function remoteVaultSummary(
  overrides: Partial<RemoteVaultSummaryResponse["vaults"][number]> = {},
): RemoteVaultSummaryResponse["vaults"][number] {
  return {
    id: "vault-remote",
    organizationId: "org-1",
    name: "Remote",
    activeKeyVersion: 1,
    createdAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}
