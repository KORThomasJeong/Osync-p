import { describe, expect, it } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "../sync/core/file-rules";
import { normalizeOsyncPluginSettings } from "./schema";

describe("normalizeOsyncPluginSettings", () => {
  const defaultApiBaseUrl = "https://api.synch.test";

  it("defaults the API base URL when existing settings do not include it", () => {
    expect(
      normalizeOsyncPluginSettings(
        {
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);
  });

  it("trims whitespace and trailing slashes from the API base URL", () => {
    expect(
      normalizeOsyncPluginSettings(
        {
          apiBaseUrl: " https://api.synch.test/// ",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe("https://api.synch.test");
  });

  it("defaults invalid and non-http API base URLs", () => {
    expect(
      normalizeOsyncPluginSettings(
        {
          apiBaseUrl: "not-a-url",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);

    expect(
      normalizeOsyncPluginSettings(
        {
          apiBaseUrl: "ftp://api.synch.test",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);
  });

  it("defaults API base URLs with query strings or fragments", () => {
    expect(
      normalizeOsyncPluginSettings(
        {
          apiBaseUrl: "https://api.synch.test?env=dev",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);

    expect(
      normalizeOsyncPluginSettings(
        {
          apiBaseUrl: "https://api.synch.test#dev",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);
  });
});
