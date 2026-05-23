import { Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { AuthManager } from "./manager";
import type { AuthClient, DeviceAuthorizationStart } from "./client";
import {
  readAuthSessionToken,
  writeAuthSessionToken,
} from "./storage";

describe("AuthManager", () => {
  it("treats a stored token as signed in only after the server confirms a session", async () => {
    const plugin = new Plugin();
    await writeAuthSessionToken(plugin, "stored-token");
    const getAuthenticatedUser = vi.fn(async () => ({
      userId: "user-1",
      email: "user@example.com",
      name: "User One",
    }));
    const manager = createManager({
      plugin,
      authClient: {
        getAuthenticatedUser,
      } as unknown as AuthClient,
    });

    expect(manager.hasAuthenticatedSession()).toBe(false);

    await manager.initialize();

    expect(getAuthenticatedUser).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      "stored-token",
    );
    expect(manager.hasAuthenticatedSession()).toBe(true);
    expect(manager.getAuthStatusLabel()).toBe("Signed in as user@example.com.");
  });

  it("keeps a stored token and asks for sign-in again when the server does not return a session", async () => {
    const plugin = new Plugin();
    await writeAuthSessionToken(plugin, "stale-token");
    const manager = createManager({
      plugin,
      authClient: {
        getAuthenticatedUser: vi.fn(async () => null),
      } as unknown as AuthClient,
    });

    await manager.initialize();

    expect(manager.hasAuthenticatedSession()).toBe(false);
    expect(manager.getAuthSessionToken()).toBe("stale-token");
    expect(manager.getAuthStatusLabel()).toBe("Sign in again to sync.");
    await expect(readAuthSessionToken(plugin)).resolves.toBe("stale-token");
  });

  it("keeps a stored token and asks for sign-in again when session lookup fails", async () => {
    const plugin = new Plugin();
    await writeAuthSessionToken(plugin, "expired-token");
    const manager = createManager({
      plugin,
      authClient: {
        getAuthenticatedUser: vi.fn(async () => {
          throw new Error("session lookup failed with status 401");
        }),
      } as unknown as AuthClient,
    });

    await manager.initialize();

    expect(manager.hasAuthenticatedSession()).toBe(false);
    expect(manager.getAuthSessionToken()).toBe("expired-token");
    expect(manager.getAuthStatusLabel()).toBe("Sign in again to sync.");
    await expect(readAuthSessionToken(plugin)).resolves.toBe("expired-token");
  });

  it("reopens the active device authorization instead of starting another one", async () => {
    const authorization = createAuthorization();
    const delay = createDeferred<void>();
    const startDeviceAuthorization = vi.fn(async () => authorization);
    const pollDeviceAuthorization = vi.fn(async () => ({
      status: "expired" as const,
      message: "expired",
    }));
    const notify = vi.fn();
    const openExternalUrl = vi.fn();
    const refreshUi = vi.fn();
    const manager = createManager({
      authClient: {
        startDeviceAuthorization,
        pollDeviceAuthorization,
      } as unknown as AuthClient,
      delay: async () => await delay.promise,
      notify,
      openExternalUrl,
      refreshUi,
    });

    const login = manager.beginDeviceLogin();
    await flushPromises();

    expect(manager.isDeviceLoginInProgress()).toBe(true);
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenLastCalledWith(
      authorization.verificationUriComplete,
    );

    const reopened = await manager.beginDeviceLogin();

    expect(reopened).toBe(false);
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledTimes(2);
    expect(openExternalUrl).toHaveBeenLastCalledWith(
      authorization.verificationUriComplete,
    );
    expect(notify).not.toHaveBeenCalledWith(
      "Device sign-in is already in progress.",
    );
    expect(notify).toHaveBeenLastCalledWith(
      `Opening browser for device sign-in...\nCode: ${authorization.userCode}`,
    );

    delay.resolve();
    await login;

    expect(manager.isDeviceLoginInProgress()).toBe(false);
  });

  it("clears the active authorization after device login finishes", async () => {
    const firstDelay = createDeferred<void>();
    const secondDelay = createDeferred<void>();
    const startDeviceAuthorization = vi.fn(async () => createAuthorization());
    const pollDeviceAuthorization = vi.fn(async () => ({
      status: "expired" as const,
      message: "expired",
    }));
    const openExternalUrl = vi.fn();
    const manager = createManager({
      authClient: {
        startDeviceAuthorization,
        pollDeviceAuthorization,
      } as unknown as AuthClient,
      delay: vi
        .fn()
        .mockImplementationOnce(async () => await firstDelay.promise)
        .mockImplementationOnce(async () => await secondDelay.promise),
      openExternalUrl,
    });

    const firstLogin = manager.beginDeviceLogin();
    await flushPromises();
    firstDelay.resolve();
    await firstLogin;

    expect(manager.isDeviceLoginInProgress()).toBe(false);

    const secondLogin = manager.beginDeviceLogin();
    await flushPromises();

    expect(startDeviceAuthorization).toHaveBeenCalledTimes(2);
    expect(openExternalUrl).toHaveBeenCalledTimes(2);

    secondDelay.resolve();
    await secondLogin;
  });

  it("does not restart authorization while the first request is still starting", async () => {
    const authorization = createAuthorization();
    const start = createDeferred<DeviceAuthorizationStart>();
    const delay = createDeferred<void>();
    const startDeviceAuthorization = vi.fn(async () => await start.promise);
    const notify = vi.fn();
    const openExternalUrl = vi.fn();
    const manager = createManager({
      authClient: {
        startDeviceAuthorization,
        pollDeviceAuthorization: vi.fn(async () => ({
          status: "expired" as const,
          message: "expired",
        })),
      } as unknown as AuthClient,
      delay: async () => await delay.promise,
      notify,
      openExternalUrl,
    });

    const login = manager.beginDeviceLogin();
    await flushPromises();

    const duplicate = await manager.beginDeviceLogin();

    expect(duplicate).toBe(false);
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Device sign-in is starting...");

    start.resolve(authorization);
    await flushPromises();
    delay.resolve();
    await login;
  });
});

function createManager(
  overrides: Partial<{
    plugin: Plugin;
    authClient: AuthClient;
    delay: (ms: number) => Promise<void>;
    notify: (message: string) => void;
    openExternalUrl: (url: string) => void;
    refreshUi: () => void;
  }> = {},
): AuthManager {
  return new AuthManager({
    plugin: overrides.plugin ?? new Plugin(),
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    refreshUi: overrides.refreshUi ?? vi.fn(),
    authClient: overrides.authClient,
    notify: overrides.notify ?? vi.fn(),
    openExternalUrl: overrides.openExternalUrl ?? vi.fn(),
    delay: overrides.delay,
  });
}

function createAuthorization(): DeviceAuthorizationStart {
  return {
    deviceCode: "device-code",
    userCode: "USER-CODE",
    verificationUri: "https://example.com/device",
    verificationUriComplete: "https://example.com/device?user_code=USER-CODE",
    expiresIn: 60,
    interval: 1,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
