import {
  defaultHttpClient,
  extractErrorMessage,
  stripTrailingSlash,
  SyncHttpError,
  type HttpClient,
  type HttpResponseLike,
} from "../http/request";
import {
  RemoteVaultPasswordChangeRejectedError,
  type ChangeVaultPasswordRequest,
  type ChangeVaultPasswordResponse,
  type CreateRemoteVaultRequest,
  type CreateRemoteVaultResponse,
  type RemoteVaultBootstrapResponse,
  type RemoteVaultKeyWrapperRecord,
  type RemoteVaultPasswordChangeRejectedCode,
  type RemoteVaultSummaryResponse,
} from "./types";

export class RemoteVaultClient {
  constructor(private readonly httpClient: HttpClient = defaultHttpClient) {}

  async listRemoteVaults(
    apiBaseUrl: string,
    sessionToken: string,
  ): Promise<RemoteVaultSummaryResponse> {
    return await this.requestJson<RemoteVaultSummaryResponse>(
      `${stripTrailingSlash(apiBaseUrl)}/v1/vaults`,
      sessionToken,
    );
  }

  async createRemoteVault(
    apiBaseUrl: string,
    sessionToken: string,
    input: CreateRemoteVaultRequest,
  ): Promise<CreateRemoteVaultResponse> {
    return await this.requestJson<CreateRemoteVaultResponse>(
      `${stripTrailingSlash(apiBaseUrl)}/v1/vaults`,
      sessionToken,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  async getRemoteVaultBootstrap(
    apiBaseUrl: string,
    sessionToken: string,
    vaultId: string,
  ): Promise<RemoteVaultBootstrapResponse> {
    return await this.requestJson<RemoteVaultBootstrapResponse>(
      `${stripTrailingSlash(apiBaseUrl)}/v1/vaults/${encodeURIComponent(vaultId)}/bootstrap`,
      sessionToken,
    );
  }

  async changeVaultPassword(
    apiBaseUrl: string,
    sessionToken: string,
    vaultId: string,
    payload: ChangeVaultPasswordRequest,
  ): Promise<RemoteVaultKeyWrapperRecord> {
    const url = `${stripTrailingSlash(apiBaseUrl)}/v1/vaults/${encodeURIComponent(
      vaultId,
    )}/password-wrapper`;
    const response = await this.httpClient.request({
      url,
      method: "PUT",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (response.status < 200 || response.status >= 300) {
      throwPasswordChangeError(response);
    }

    const body = response.json as ChangeVaultPasswordResponse | undefined;
    if (!body || !body.wrapper) {
      throw new Error("vault password change response missing wrapper");
    }
    return body.wrapper;
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
      throw new SyncHttpError(
        response.status,
        message || `vault request failed with status ${response.status}`,
      );
    }

    return response.json as T;
  }
}

function throwPasswordChangeError(response: HttpResponseLike): never {
  const code = extractErrorCode(response.json);
  const message =
    extractErrorMessage(response.json) ||
    `vault password change failed with status ${response.status}`;

  if (
    response.status === 409 &&
    (code === "fingerprint_mismatch" || code === "fingerprint_unset")
  ) {
    throw new RemoteVaultPasswordChangeRejectedError(code, message);
  }
  if (response.status === 404 && code === "wrapper_not_found") {
    throw new RemoteVaultPasswordChangeRejectedError("wrapper_not_found", message);
  }

  throw new Error(message);
}

function extractErrorCode(value: unknown): RemoteVaultPasswordChangeRejectedCode | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string") {
    return null;
  }
  if (
    record.code === "fingerprint_mismatch" ||
    record.code === "fingerprint_unset" ||
    record.code === "wrapper_not_found"
  ) {
    return record.code;
  }
  return null;
}
