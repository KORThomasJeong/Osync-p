import { Notice } from "obsidian";

import type { Plugin } from "obsidian";

import {
  AuthClient,
  type AuthenticatedUserSession,
  type DeviceAuthorizationPollResult,
  type DeviceAuthorizationStart,
} from "./client";
import {
  clearAuthSessionToken,
  readAuthSessionToken,
  writeAuthSessionToken,
} from "./storage";

export interface AuthManagerDeps {
  plugin: Plugin;
  getApiBaseUrl: () => string;
  refreshUi: () => void;
  authClient?: AuthClient;
  notify?: (message: string) => void;
  openExternalUrl?: (url: string) => void;
  delay?: (ms: number) => Promise<void>;
  onSignInUrlError?: (message: string) => void;
}

export class AuthManager {
  private authSessionToken = "";
  private authSessionVerified = false;
  private authNeedsRelogin = false;
  private authDisplayName = "";
  private readonly authClient: AuthClient;
  private deviceLoginInFlight = false;
  private deviceAuthorization: DeviceAuthorizationStart | null = null;

  constructor(private readonly deps: AuthManagerDeps) {
    this.authClient = deps.authClient ?? new AuthClient();
  }

  async initialize(): Promise<void> {
    this.authSessionToken = await readAuthSessionToken(this.deps.plugin);
    this.authSessionVerified = false;
    if (!this.authSessionToken) {
      return;
    }

    await this.refreshIdentity();
  }

  async reverifyIfNeeded(): Promise<void> {
    if (this.authSessionVerified) {
      return;
    }

    if (!this.authSessionToken.trim()) {
      return;
    }

    await this.refreshIdentity();
  }

  getAuthSessionToken(): string {
    return this.authSessionToken;
  }

  getAuthStatusLabel(): string {
    if (!this.hasAuthenticatedSession()) {
      if (this.authNeedsRelogin) {
        return "Sign in again to sync.";
      }

      return "Not signed in.";
    }

    if (this.authDisplayName) {
      return `Signed in as ${this.authDisplayName}.`;
    }

    return "Signed in on this device.";
  }

  hasAuthenticatedSession(): boolean {
    return this.authSessionVerified;
  }

  isDeviceLoginInProgress(): boolean {
    return this.deviceLoginInFlight;
  }

  async beginDeviceLogin(): Promise<boolean> {
    if (this.deviceLoginInFlight) {
      this.reopenDeviceLogin();
      return false;
    }

    this.deviceLoginInFlight = true;
    this.deviceAuthorization = null;
    this.deps.refreshUi();
    const apiBaseUrl = this.deps.getApiBaseUrl();

    try {
      const authorization = await this.authClient.startDeviceAuthorization(
        apiBaseUrl,
      );
      this.deviceAuthorization = authorization;
      this.deps.refreshUi();

      let cancelled = false;
      this.openDeviceLogin(authorization);

      let pollDelayMs = authorization.interval * 1000;
      const deadline = Date.now() + authorization.expiresIn * 1000;

      while (!cancelled && Date.now() < deadline) {
        await this.wait(pollDelayMs);

        if (cancelled) {
          break;
        }

        const poll = await this.authClient.pollDeviceAuthorization(
          apiBaseUrl,
          authorization.deviceCode,
        );

        if (poll.status === "approved") {
          this.notify("Approval received. Finishing sign-in...");
          await this.completeDeviceLogin(poll);
          this.notify(`Signed in: ${this.getAuthStatusLabel()}`);
          return true;
        }

        if (poll.status === "pending" || poll.status === "slow_down") {
          pollDelayMs = poll.intervalMs;
          continue;
        }

        this.notify(`Device sign-in failed: ${poll.message}`);
        return true;
      }

      if (cancelled) {
        this.notify("Device sign-in canceled.");
        return true;
      }

      this.notify("Device sign-in expired. Start again from Obsidian.");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.deps.onSignInUrlError && isUrlError(message)) {
        this.deps.onSignInUrlError(message);
      } else {
        this.notify(`Device sign-in failed: ${message}`);
      }
      return true;
    } finally {
      this.deviceLoginInFlight = false;
      this.deviceAuthorization = null;
      this.deps.refreshUi();
    }
  }

  async signOutDevice(): Promise<void> {
    if (!this.authSessionToken.trim()) {
      return;
    }

    const apiBaseUrl = this.deps.getApiBaseUrl();

    try {
      if (this.authSessionToken) {
        await this.authClient.signOut(
          apiBaseUrl,
          this.authSessionToken,
        );
      }
    } finally {
      await this.clearLocalAuthSession();
      this.deps.refreshUi();
    }

    this.notify("Signed out on this device.");
  }

  private async completeDeviceLogin(
    poll: Extract<DeviceAuthorizationPollResult, { status: "approved" }>,
  ): Promise<void> {
    const session = await this.authClient.getAuthenticatedUser(
      this.deps.getApiBaseUrl(),
      poll.accessToken,
    );
    if (!session) {
      throw new Error("approved device authorization did not create a session");
    }

    this.authSessionToken = poll.accessToken;
    this.applyVerifiedSession(session);
    await writeAuthSessionToken(this.deps.plugin, this.authSessionToken);
    this.deps.refreshUi();
  }

  private notify(message: string): void {
    if (this.deps.notify) {
      this.deps.notify(message);
      return;
    }

    new Notice(message);
  }

  private reopenDeviceLogin(): void {
    if (!this.deviceAuthorization) {
      this.notify("Device sign-in is starting...");
      return;
    }

    this.openDeviceLogin(this.deviceAuthorization);
  }

  private openDeviceLogin(authorization: DeviceAuthorizationStart): void {
    this.notify(
      `Opening browser for device sign-in...\nCode: ${authorization.userCode}`,
    );
    this.openExternalUrl(authorization.verificationUriComplete);
  }

  private openExternalUrl(url: string): void {
    if (this.deps.openExternalUrl) {
      this.deps.openExternalUrl(url);
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }

  private wait(ms: number): Promise<void> {
    if (this.deps.delay) {
      return this.deps.delay(ms);
    }

    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  private async refreshIdentity(): Promise<void> {
    try {
      const session = await this.authClient.getAuthenticatedUser(
        this.deps.getApiBaseUrl(),
        this.authSessionToken,
      );
      if (!session) {
        this.markAuthNeedsRelogin();
        return;
      }

      this.applyVerifiedSession(session);
    } catch {
      this.markAuthNeedsRelogin();
    } finally {
      this.deps.refreshUi();
    }
  }

  private applyVerifiedSession(session: AuthenticatedUserSession): void {
    this.authSessionVerified = true;
    this.authNeedsRelogin = false;
    this.authDisplayName = session.email || session.name || "";
  }

  private markAuthNeedsRelogin(): void {
    this.authSessionVerified = false;
    this.authNeedsRelogin = true;
    this.authDisplayName = "";
  }

  private async clearLocalAuthSession(): Promise<void> {
    this.authSessionToken = "";
    this.authSessionVerified = false;
    this.authNeedsRelogin = false;
    this.authDisplayName = "";
    await clearAuthSessionToken(this.deps.plugin);
  }
}

function isUrlError(message: string): boolean {
  return /invalid url/i.test(message);
}
