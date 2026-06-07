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
 *
 * Uses the server "sign-upload" flow (server 2.1.7+): we first ask the API
 * for a presigned PUT URL, then PUT the bytes directly to MinIO. Falls back
 * to a direct PUT to the API for older servers (sign endpoint returns 404).
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
      const signResponse = await this.httpClient.request({
        path: () =>
          `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}/sign-upload?size=${bytes.byteLength}`,
        method: "GET",
      });
      const signStatus = signResponse.response.status;

      if (signStatus === 404) {
        // Older server without sign-upload — fall back to direct PUT.
        const response = await this.httpClient.putBytes(
          `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
          bytes,
          { "x-blob-size": String(bytes.byteLength) },
        );
        this.throwUnlessUploadSucceeded(response);
        return;
      }

      if (signStatus < 200 || signStatus >= 300) {
        this.throwUnlessUploadSucceeded(signResponse.response);
        return;
      }

      const signed = parseSignUploadResponse(signResponse.response.json);
      if (signed.alreadyLive) {
        return;
      }
      if (!signed.url) {
        throw new SyncBlobUploadError(
          signStatus,
          "invalid_sign_response",
          "sign-upload response missing url",
        );
      }

      const putResponse = await this.fallbackHttpClient.request({
        url: signed.url,
        method: "PUT",
        body: toArrayBuffer(bytes),
      });
      this.throwUnlessUploadSucceeded(putResponse);
      return;
    }

    const signResponse = await this.fallbackHttpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}/sign-upload?size=${bytes.byteLength}`,
      method: "GET",
      headers: {
        authorization: `Bearer ${syncToken}`,
      },
    });

    if (signResponse.status === 404) {
      // Older server without sign-upload — fall back to direct PUT.
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
      return;
    }

    if (signResponse.status < 200 || signResponse.status >= 300) {
      this.throwUnlessUploadSucceeded(signResponse);
      return;
    }

    const signed = parseSignUploadResponse(signResponse.json);
    if (signed.alreadyLive) {
      return;
    }
    if (!signed.url) {
      throw new SyncBlobUploadError(
        signResponse.status,
        "invalid_sign_response",
        "sign-upload response missing url",
      );
    }

    const putResponse = await this.fallbackHttpClient.request({
      url: signed.url,
      method: "PUT",
      body: toArrayBuffer(bytes),
    });
    this.throwUnlessUploadSucceeded(putResponse);
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

interface ParsedSignUploadResponse {
  alreadyLive: boolean;
  url: string;
}

function parseSignUploadResponse(value: unknown): ParsedSignUploadResponse {
  if (!value || typeof value !== "object") {
    return { alreadyLive: false, url: "" };
  }
  const record = value as Record<string, unknown>;
  const alreadyLive = record.alreadyLive === true;
  const url = typeof record.url === "string" ? record.url : "";
  return { alreadyLive, url };
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
