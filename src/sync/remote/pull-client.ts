import {
  defaultHttpClient,
  extractErrorMessage,
  stripTrailingSlash,
  type HttpClient,
  type HttpResponseLike,
} from "../../http/request";
import type { SyncHttpClient } from "./http-client";

/**
 * Domain-specific helpers for blob downloads. The auth + URL plumbing lives in
 * `SyncHttpClient`; this class only adds the blob-download response decoding.
 *
 * Uses the server "sign-download" flow (server 2.1.7+): we first ask the API
 * for a presigned GET URL, then GET the bytes directly from MinIO. Falls back
 * to a direct GET against the API if the sign endpoint 404s (older servers).
 *
 * A 404 on sign-download is ambiguous between "blob missing" and "old server
 * without the endpoint". We handle this by always falling back to the legacy
 * direct-GET path on 404 — if the blob really doesn't exist the legacy GET
 * will itself return 404 and surface as a download error.
 */
export class SyncPullClient {
  constructor(
    private readonly httpClient?: SyncHttpClient,
    private readonly fallbackHttpClient: HttpClient = defaultHttpClient,
  ) {}

  async downloadBlob(
    apiBaseUrl: string,
    syncToken: string,
    vaultId: string,
    blobId: string,
  ): Promise<Uint8Array> {
    if (this.httpClient) {
      const signResponse = await this.httpClient.request({
        path: () =>
          `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}/sign-download`,
        method: "GET",
      });
      const signStatus = signResponse.response.status;

      if (signStatus === 404) {
        // Either old server without sign-download, or blob really missing.
        // Fall back to legacy direct GET; if the blob is missing the legacy
        // endpoint will itself 404 and we'll surface that error.
        const { response } = await this.httpClient.request({
          path: () =>
            `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
        });
        return this.readDownloadResponse(response);
      }

      if (signStatus < 200 || signStatus >= 300) {
        return this.readDownloadResponse(signResponse.response);
      }

      const url = parseSignDownloadUrl(signResponse.response.json);
      if (!url) {
        throw new Error("sign-download response missing url");
      }

      const getResponse = await this.fallbackHttpClient.request({
        url,
        method: "GET",
      });
      return this.readDownloadResponse(getResponse);
    }

    const signResponse = await this.fallbackHttpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}/sign-download`,
      method: "GET",
      headers: {
        authorization: `Bearer ${syncToken}`,
      },
    });

    if (signResponse.status === 404) {
      const response = await this.fallbackHttpClient.request({
        url: `${stripTrailingSlash(apiBaseUrl)}/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
        method: "GET",
        headers: {
          authorization: `Bearer ${syncToken}`,
        },
      });
      return this.readDownloadResponse(response);
    }

    if (signResponse.status < 200 || signResponse.status >= 300) {
      return this.readDownloadResponse(signResponse);
    }

    const url = parseSignDownloadUrl(signResponse.json);
    if (!url) {
      throw new Error("sign-download response missing url");
    }

    const getResponse = await this.fallbackHttpClient.request({
      url,
      method: "GET",
    });
    return this.readDownloadResponse(getResponse);
  }

  private readDownloadResponse(response: HttpResponseLike): Uint8Array {
    if (response.status < 200 || response.status >= 300) {
      const message = extractErrorMessage(response.json);
      throw new Error(message || `blob download failed with status ${response.status}`);
    }

    if (response.arrayBuffer instanceof ArrayBuffer) {
      return new Uint8Array(response.arrayBuffer);
    }

    throw new Error("blob download response did not include an ArrayBuffer body");
  }
}

function parseSignDownloadUrl(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  return typeof record.url === "string" ? record.url : "";
}
