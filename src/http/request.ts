import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";

/** Default bound for JSON/API calls. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** Watchdog for blob transfers: generous enough for a large attachment on slow LTE, but finite. */
export const BLOB_TRANSFER_TIMEOUT_MS = 300_000;

/**
 * Raised when a request did not settle within its timeout. Obsidian's
 * `requestUrl` has no timeout of its own, so a request in flight while the
 * phone's network changes (or the app is suspended) can hang forever. This is
 * a transport failure — the server never answered — so it must be treated as
 * transient (retry later), never as an auth rejection.
 */
export class RequestTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * The one entry point for Obsidian `requestUrl` in the plugin. Races the
 * request against a timeout; the underlying request cannot be cancelled, so a
 * late settlement is simply ignored.
 */
export function requestUrlWithTimeout(
  params: RequestUrlParam,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<RequestUrlResponse> {
  return new Promise<RequestUrlResponse>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RequestTimeoutError(params.url, timeoutMs));
    }, timeoutMs);

    let pending: Promise<RequestUrlResponse>;
    try {
      pending = Promise.resolve(requestUrl(params));
    } catch (error) {
      pending = Promise.reject(error);
    }

    pending.then(
      (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
  /** Overrides {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface HttpResponseLike {
  status: number;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
}

export interface HttpClient {
  request(input: HttpRequestInput): Promise<HttpResponseLike>;
}

export class ObsidianHttpClient implements HttpClient {
  async request(input: HttpRequestInput): Promise<HttpResponseLike> {
    return (await requestUrlWithTimeout(
      {
        url: input.url,
        method: input.method ?? "GET",
        throw: false,
        headers: input.headers,
        body: input.body,
      },
      input.timeoutMs,
    )) as HttpResponseLike;
  }
}

export const defaultHttpClient: HttpClient = new ObsidianHttpClient();

export class SyncHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export function extractErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error;
  }

  return "";
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
