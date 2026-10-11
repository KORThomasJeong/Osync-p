import {
  defaultHttpClient,
  extractErrorMessage,
  stripTrailingSlash,
  SyncHttpError,
  type HttpClient,
} from "../../http/request";
import { RemoteVaultKeyMismatchError } from "../../remote-vault/types";

export interface SyncTokenResponse {
  token: string;
  expiresAt: number;
  vaultId: string;
  localVaultId: string;
}

export class SyncAccessClient {
  constructor(private readonly httpClient: HttpClient = defaultHttpClient) {}

  async issueSyncToken(
    apiBaseUrl: string,
    sessionToken: string,
    input: { vaultId: string; localVaultId: string; keyFingerprint?: string },
  ): Promise<SyncTokenResponse> {
    return await this.requestJson<SyncTokenResponse>(
      `${stripTrailingSlash(apiBaseUrl)}/v1/sync/token`,
      sessionToken,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  private async requestJson<T>(
    url: string,
    sessionToken: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const response = await this.httpClient.request({
      url,
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        ...(init.body
          ? {
              "content-type": "application/json",
            }
          : {}),
      },
      body: init.body,
    });

    if (response.status < 200 || response.status >= 300) {
      const message = extractErrorMessage(response.json);
      if (response.status === 409 && readErrorCode(response.json) === "key_mismatch") {
        // The server recorded a different key fingerprint for this vault: this device
        // holds another vault's key. Never retry with it.
        throw new RemoteVaultKeyMismatchError(readVaultId(init.body), message || undefined);
      }
      throw new SyncHttpError(
        response.status,
        message || `sync access request failed with status ${response.status}`,
      );
    }

    return response.json as T;
  }
}

function readErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string") {
    return record.code;
  }
  return typeof record.error === "string" ? record.error : null;
}

function readVaultId(body: string | undefined): string {
  try {
    const parsed = JSON.parse(body ?? "{}") as Record<string, unknown>;
    return typeof parsed.vaultId === "string" ? parsed.vaultId : "";
  } catch {
    return "";
  }
}
