import {
  defaultHttpClient,
  extractErrorMessage,
  stripTrailingSlash,
  type HttpClient,
  type HttpResponseLike,
} from "../../http/request";
import type { SyncTokenResponse } from "./client";

export interface SyncHttpClientDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  invalidateSyncToken: () => void;
  httpClient?: HttpClient;
}

export interface SyncAuthorizedRequestInput {
  path: (token: SyncTokenResponse) => string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface SyncAuthorizedRequestResult {
  response: HttpResponseLike;
  token: SyncTokenResponse;
}

/**
 * Single HTTP client for the sync API. Owns authentication, base URL composition,
 * and 401-retry semantics. Domain-specific clients (SyncBlobClient, SyncPullClient)
 * delegate to this for the auth+URL plumbing.
 */
export class SyncHttpClient {
  private readonly httpClient: HttpClient;

  constructor(private readonly deps: SyncHttpClientDeps) {
    this.httpClient = deps.httpClient ?? defaultHttpClient;
  }

  /**
   * Issues an authenticated request with automatic single-shot retry on 401.
   * The path callback receives the active sync token so callers can substitute
   * the vault id (or any token-derived value) into the URL.
   */
  async request(input: SyncAuthorizedRequestInput): Promise<SyncAuthorizedRequestResult> {
    let retrying = false;

    while (true) {
      const token = await this.deps.getSyncToken();
      const response = await this.httpClient.request({
        url: `${stripTrailingSlash(this.deps.getApiBaseUrl())}${input.path(token)}`,
        method: input.method ?? "GET",
        headers: {
          authorization: `Bearer ${token.token}`,
          ...input.headers,
        },
        body: input.body,
      });

      if (response.status !== 401 || retrying) {
        return { response, token };
      }

      retrying = true;
      this.deps.invalidateSyncToken();
    }
  }

  /**
   * GETs JSON from the sync API. The caller is responsible for validating the
   * shape of T at runtime if it matters.
   */
  async getJson<T>(path: string): Promise<T> {
    const { response } = await this.request({
      path: () => path,
      method: "GET",
    });
    return readJsonOrThrow<T>(response);
  }

  /** POSTs a JSON body and returns the parsed JSON response. */
  async postJson<T>(path: string, body: unknown): Promise<T> {
    const { response } = await this.request({
      path: () => path,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return readJsonOrThrow<T>(response);
  }

  /** GETs raw bytes from the sync API. Throws on non-2xx responses. */
  async getBytes(path: string): Promise<Uint8Array> {
    const { response } = await this.request({
      path: () => path,
      method: "GET",
    });
    return readBytesOrThrow(response);
  }

  /**
   * PUTs raw bytes. Returns the raw response so callers can observe the status
   * (e.g. blob upload treats 409 as "already exists, no-op"). Does NOT throw on
   * non-2xx; the caller decides how to interpret the status.
   */
  async putBytes(
    path: string,
    bytes: Uint8Array,
    extraHeaders?: Record<string, string>,
  ): Promise<HttpResponseLike> {
    const { response } = await this.request({
      path: () => path,
      method: "PUT",
      headers: extraHeaders,
      body: toArrayBuffer(bytes),
    });
    return response;
  }
}

/**
 * Backward-compatible alias. The `SyncAuthorizedRequestClient` name is preserved
 * so existing imports keep working; new code should use `SyncHttpClient`.
 */
export { SyncHttpClient as SyncAuthorizedRequestClient };
export type SyncAuthorizedRequestClientDeps = SyncHttpClientDeps;

function readJsonOrThrow<T>(response: HttpResponseLike): T {
  if (response.status < 200 || response.status >= 300) {
    const message = extractErrorMessage(response.json);
    throw new Error(message || `sync request failed with status ${response.status}`);
  }
  return response.json as T;
}

function readBytesOrThrow(response: HttpResponseLike): Uint8Array {
  if (response.status < 200 || response.status >= 300) {
    const message = extractErrorMessage(response.json);
    throw new Error(message || `sync request failed with status ${response.status}`);
  }
  if (response.arrayBuffer instanceof ArrayBuffer) {
    return new Uint8Array(response.arrayBuffer);
  }
  throw new Error("sync request response did not include an ArrayBuffer body");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
