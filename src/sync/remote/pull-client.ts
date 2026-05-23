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
      const { response } = await this.httpClient.request({
        path: () =>
          `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      });
      return this.readDownloadResponse(response);
    }

    const response = await this.fallbackHttpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      method: "GET",
      headers: {
        authorization: `Bearer ${syncToken}`,
      },
    });

    return this.readDownloadResponse(response);
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
