import {
  defaultHttpClient,
  extractErrorMessage,
  stripTrailingSlash,
  type HttpClient,
  type HttpResponseLike,
} from "../../http/request";
import type { SyncHttpClient } from "./http-client";

/**
 * Domain-specific helpers for blob uploads. The auth + URL plumbing lives in
 * `SyncHttpClient`; this class only adds blob-specific status interpretation
 * and the {@link SyncBlobUploadError} typed error.
 */
export class SyncBlobClient {
  constructor(
    private readonly httpClient?: SyncHttpClient,
    private readonly fallbackHttpClient: HttpClient = defaultHttpClient,
  ) {}

  async uploadBlob(
    apiBaseUrl: string,
    syncToken: string,
    vaultId: string,
    blobId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    if (this.httpClient) {
      const response = await this.httpClient.putBytes(
        `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
        bytes,
        { "x-blob-size": String(bytes.byteLength) },
      );
      this.throwUnlessUploadSucceeded(response);
      return;
    }

    const response = await this.fallbackHttpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      method: "PUT",
      body: toArrayBuffer(bytes),
      headers: {
        authorization: `Bearer ${syncToken}`,
        "x-blob-size": String(bytes.byteLength),
      },
    });

    this.throwUnlessUploadSucceeded(response);
  }

  private throwUnlessUploadSucceeded(response: HttpResponseLike): void {
    if (response.status >= 200 && response.status < 300) {
      return;
    }

    if (response.status === 409) {
      return;
    }

    const message = extractErrorMessage(response.json);
    throw new SyncBlobUploadError(
      response.status,
      extractErrorCode(response.json),
      message || `blob upload failed with status ${response.status}`,
    );
  }
}

export class SyncBlobUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncBlobUploadError";
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function extractErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  return typeof record.error === "string" ? record.error.trim() : "";
}
