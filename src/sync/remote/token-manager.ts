import type { SyncTokenResponse } from "./client";
import { SyncAccessClient } from "./client";

const REFRESH_SKEW_SECONDS = 15;

export interface SyncTokenManagerDeps {
  getApiBaseUrl: () => string;
  getAuthSessionToken: () => string;
  getRemoteVaultId: () => string | null;
  getLocalVaultId: () => Promise<string>;
  // Fingerprint of the vault key this device encrypts with. Sent with every token
  // request so the server can refuse a device holding another vault's key.
  getKeyFingerprint?: () => Promise<string | null>;
  syncAccessClient?: SyncAccessClient;
  now?: () => number;
}

export class SyncTokenManager {
  private readonly syncAccessClient: SyncAccessClient;
  private cachedToken: SyncTokenResponse | null = null;
  private cachedTokenKeyFingerprint: string | null = null;

  constructor(private readonly deps: SyncTokenManagerDeps) {
    this.syncAccessClient = deps.syncAccessClient ?? new SyncAccessClient();
  }

  async getTokenForActiveRemoteVault(): Promise<SyncTokenResponse> {
    const sessionToken = this.deps.getAuthSessionToken().trim();
    if (!sessionToken) {
      throw new Error("Sign in before requesting a sync token.");
    }

    const vaultId = this.deps.getRemoteVaultId()?.trim() ?? "";
    if (!vaultId) {
      throw new Error("Connect a vault before requesting a sync token.");
    }

    const localVaultId = (await this.deps.getLocalVaultId()).trim();
    if (!localVaultId) {
      throw new Error("Local vault ID is not available.");
    }

    const keyFingerprint = (await this.deps.getKeyFingerprint?.()) ?? null;

    if (
      this.cachedToken &&
      this.cachedTokenKeyFingerprint === keyFingerprint &&
      this.canReuseToken(this.cachedToken, vaultId, localVaultId)
    ) {
      return this.cachedToken;
    }

    const issued = await this.syncAccessClient.issueSyncToken(
      this.deps.getApiBaseUrl(),
      sessionToken,
      {
        vaultId,
        localVaultId,
        ...(keyFingerprint ? { keyFingerprint } : {}),
      },
    );

    this.cachedToken = issued;
    this.cachedTokenKeyFingerprint = keyFingerprint;
    return issued;
  }

  clear(): void {
    this.cachedToken = null;
    this.cachedTokenKeyFingerprint = null;
  }

  private canReuseToken(
    token: SyncTokenResponse,
    vaultId: string,
    localVaultId: string,
  ): boolean {
    return (
      token.vaultId === vaultId &&
      token.localVaultId === localVaultId &&
      token.expiresAt > this.nowSeconds() + REFRESH_SKEW_SECONDS
    );
  }

  private nowSeconds(): number {
    const now = this.deps.now ?? Date.now;
    return Math.floor(now() / 1000);
  }
}
