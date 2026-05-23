/**
 * Authentication-domain surface for the settings UI.
 *
 * Exposes the subset of the controller concerned with sign-in / sign-out,
 * device login state, and the API base URL the user signs in against.
 *
 * Implementations include `OsyncPluginController`, which satisfies this
 * facade automatically because it implements the wider
 * `OsyncSettingsController`.
 */
export interface OsyncAuthFacade {
  getAuthStatusLabel(): string;
  hasAuthenticatedSession(): boolean;
  isDeviceLoginInProgress(): boolean;
  beginDeviceLogin(): Promise<void>;
  signOutDevice(): Promise<void>;
  getApiBaseUrl(): string;
  updateApiBaseUrl(value: string): Promise<void>;
}
