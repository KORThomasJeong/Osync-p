import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRequestUrlMock } from "obsidian";

import { isAuthRejection } from "../auth/client";
import { classifyReconnectError } from "../sync/remote/reconnect-error";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  ObsidianHttpClient,
  RequestTimeoutError,
  requestUrlWithTimeout,
} from "./request";

describe("requestUrlWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setRequestUrlMock(async () => {
      throw new Error("requestUrl mock is not configured");
    });
  });

  it("rejects with RequestTimeoutError when requestUrl never settles", async () => {
    setRequestUrlMock(() => new Promise(() => {}));

    const pending = requestUrlWithTimeout({ url: "https://example.test/x" }, 1_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("uses the default timeout when none is given", async () => {
    setRequestUrlMock(() => new Promise(() => {}));
    let settled = false;
    const pending = requestUrlWithTimeout({ url: "https://example.test/x" }).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(RequestTimeoutError);
  });

  it("resolves normally and clears the timer when requestUrl answers in time", async () => {
    setRequestUrlMock(async () => ({ status: 200, json: { ok: true } }));

    await expect(
      requestUrlWithTimeout({ url: "https://example.test/x" }, 1_000),
    ).resolves.toMatchObject({ status: 200 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates requestUrl failures unchanged", async () => {
    setRequestUrlMock(async () => {
      throw new Error("net::ERR_NETWORK_CHANGED");
    });

    await expect(
      requestUrlWithTimeout({ url: "https://example.test/x" }, 1_000),
    ).rejects.toThrow("net::ERR_NETWORK_CHANGED");
  });

  it("ObsidianHttpClient honours a per-call timeout and strips it from requestUrl params", async () => {
    let captured: Record<string, unknown> | null = null;
    setRequestUrlMock((input) => {
      captured = input as Record<string, unknown>;
      return new Promise(() => {});
    });

    const pending = new ObsidianHttpClient().request({
      url: "https://example.test/blob",
      timeoutMs: 5_000,
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(captured).not.toHaveProperty("timeoutMs");
  });

  it("is classified as transient and never as an auth rejection", () => {
    const error = new RequestTimeoutError("https://example.test/x", 1_000);
    expect(classifyReconnectError(error)).toEqual({ kind: "transient" });
    expect(isAuthRejection(error)).toBe(false);
  });
});
