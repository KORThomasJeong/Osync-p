import type { Plugin } from "obsidian";

const SESSION_TOKEN_SECRET = "osync-session-token";

export async function readAuthSessionToken(plugin: Plugin): Promise<string> {
  return plugin.app.secretStorage.getSecret(SESSION_TOKEN_SECRET)?.trim() ?? "";
}

export async function writeAuthSessionToken(
  plugin: Plugin,
  sessionToken: string,
): Promise<void> {
  plugin.app.secretStorage.setSecret(SESSION_TOKEN_SECRET, sessionToken.trim());
}

export async function clearAuthSessionToken(plugin: Plugin): Promise<void> {
  plugin.app.secretStorage.setSecret(SESSION_TOKEN_SECRET, "");
}
