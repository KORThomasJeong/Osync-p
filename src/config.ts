declare const __OSYNC_API_BASE_URL__: string;

const COMPILE_TIME_API_BASE_URL =
  typeof __OSYNC_API_BASE_URL__ === "string"
    ? __OSYNC_API_BASE_URL__.trim()
    : "";

export function getDefaultApiBaseUrl(): string {
  return COMPILE_TIME_API_BASE_URL;
}

export function normalizeApiBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    if (parsed.search || parsed.hash) {
      return fallback;
    }
  } catch {
    return fallback;
  }

  return trimmed;
}

export function parseApiBaseUrlInput(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const withProtocol =
    trimmed.includes("://")
      ? trimmed
      : `https://${trimmed}`;

  const normalized = normalizeApiBaseUrl(withProtocol, "");
  if (!normalized) {
    throw new Error("API base URL must be a valid URL (e.g. myserver.com or https://myserver.com).");
  }

  return normalized;
}
