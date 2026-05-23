import { requestUrl } from "obsidian";

export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
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
    return (await requestUrl({
      url: input.url,
      method: input.method ?? "GET",
      throw: false,
      headers: input.headers,
      body: input.body,
    })) as HttpResponseLike;
  }
}

export const defaultHttpClient: HttpClient = new ObsidianHttpClient();

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
