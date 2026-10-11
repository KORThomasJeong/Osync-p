import { App, type Plugin } from "obsidian";
import { describe, expect, it } from "vitest";

import { computeVaultKeyFingerprint } from "./crypto";
import {
  clearStoredRemoteVaultKeySecret,
  LEGACY_REMOTE_VAULT_KEY_SECRET,
  readLegacyRemoteVaultKeySecret,
  readRemoteVaultKeySecretForVault,
  readStoredRemoteVaultKeySecret,
  releaseRemoteVaultKeySecret,
  remoteVaultKeySecretId,
  writeStoredRemoteVaultKeySecret,
} from "./device-storage";
import { encodeBase64 } from "../utils/bytes";

const VAULT_A = "98ec362f-0000-4000-8000-00000000000a";
const VAULT_B = "92058066-0000-4000-8000-00000000000b";

function createPlugin(): { plugin: Plugin; app: App } {
  const app = new App();
  return { plugin: { app } as unknown as Plugin, app };
}

async function secretFor(vaultId: string, bytes: number[]) {
  const remoteVaultKey = new Uint8Array(bytes);
  return {
    vaultId,
    remoteVaultKey,
    fingerprint: await computeVaultKeyFingerprint(remoteVaultKey),
  };
}

describe("per-vault key storage", () => {
  it("derives a secret id that is lowercase alnum + dashes", () => {
    expect(remoteVaultKeySecretId("98EC362F-AbCd")).toBe("osync-remote-vault-key-98ec362f-abcd");
    expect(remoteVaultKeySecretId("a_b.c")).toMatch(/^[a-z0-9-]+$/);
  });

  it("keeps two vaults' keys apart on the same device (app-wide secret storage)", async () => {
    const { plugin } = createPlugin();
    const a = await secretFor(VAULT_A, [1, 2, 3]);
    const b = await secretFor(VAULT_B, [9, 9, 9]);

    await writeStoredRemoteVaultKeySecret(plugin, a);
    await writeStoredRemoteVaultKeySecret(plugin, b);

    expect((await readStoredRemoteVaultKeySecret(plugin, VAULT_A))?.remoteVaultKey).toEqual(
      a.remoteVaultKey,
    );
    expect((await readStoredRemoteVaultKeySecret(plugin, VAULT_B))?.remoteVaultKey).toEqual(
      b.remoteVaultKey,
    );
  });

  it("stores a versioned JSON value bound to the vault id", async () => {
    const { plugin, app } = createPlugin();
    const a = await secretFor(VAULT_A, [1, 2, 3]);
    await writeStoredRemoteVaultKeySecret(plugin, a);

    const raw = JSON.parse(app.secretStorage.getSecret(remoteVaultKeySecretId(VAULT_A)) ?? "");
    expect(raw).toEqual({
      v: 1,
      vaultId: VAULT_A,
      key: encodeBase64(a.remoteVaultKey),
      fingerprint: a.fingerprint,
    });
  });

  it("rejects a value stored for a different vault id", async () => {
    const { plugin, app } = createPlugin();
    const b = await secretFor(VAULT_B, [9, 9, 9]);
    app.secretStorage.setSecret(
      remoteVaultKeySecretId(VAULT_A),
      JSON.stringify({ v: 1, vaultId: VAULT_B, key: encodeBase64(b.remoteVaultKey), fingerprint: b.fingerprint }),
    );

    expect(await readStoredRemoteVaultKeySecret(plugin, VAULT_A)).toBeNull();
  });

  it("rejects a value whose key does not match its recorded fingerprint", async () => {
    const { plugin, app } = createPlugin();
    const a = await secretFor(VAULT_A, [1, 2, 3]);
    app.secretStorage.setSecret(
      remoteVaultKeySecretId(VAULT_A),
      JSON.stringify({ v: 1, vaultId: VAULT_A, key: encodeBase64(new Uint8Array([7])), fingerprint: a.fingerprint }),
    );

    expect(await readStoredRemoteVaultKeySecret(plugin, VAULT_A)).toBeNull();
  });

  it("clears only the given vault's key", async () => {
    const { plugin } = createPlugin();
    await writeStoredRemoteVaultKeySecret(plugin, await secretFor(VAULT_A, [1]));
    await writeStoredRemoteVaultKeySecret(plugin, await secretFor(VAULT_B, [2]));

    await clearStoredRemoteVaultKeySecret(plugin, VAULT_A);

    expect(await readStoredRemoteVaultKeySecret(plugin, VAULT_A)).toBeNull();
    expect(await readStoredRemoteVaultKeySecret(plugin, VAULT_B)).not.toBeNull();
  });

  it("never reads the legacy shared secret as a per-vault key", async () => {
    const { plugin, app } = createPlugin();
    app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, encodeBase64(new Uint8Array([5, 5])));

    expect(await readStoredRemoteVaultKeySecret(plugin, VAULT_A)).toBeNull();
    expect((await readLegacyRemoteVaultKeySecret(plugin))?.remoteVaultKey).toEqual(
      new Uint8Array([5, 5]),
    );
  });

  it("prefers the vault's own key and falls back to the unbound legacy key", async () => {
    const { plugin, app } = createPlugin();
    app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, encodeBase64(new Uint8Array([5])));

    expect(await readRemoteVaultKeySecretForVault(plugin, VAULT_A)).toEqual({
      remoteVaultKey: new Uint8Array([5]),
    });

    const a = await secretFor(VAULT_A, [1, 2, 3]);
    await writeStoredRemoteVaultKeySecret(plugin, a);
    expect(await readRemoteVaultKeySecretForVault(plugin, VAULT_A)).toEqual(a);
  });

  it("release clears the legacy secret only when it is this vault's verified key", async () => {
    const { plugin, app } = createPlugin();
    const a = await secretFor(VAULT_A, [1, 2, 3]);
    await writeStoredRemoteVaultKeySecret(plugin, a);

    // The shared secret holds vault B's key: releasing A must leave it for B.
    app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, encodeBase64(new Uint8Array([9, 9, 9])));
    await releaseRemoteVaultKeySecret(plugin, VAULT_A, a);
    expect(await readStoredRemoteVaultKeySecret(plugin, VAULT_A)).toBeNull();
    expect(await readLegacyRemoteVaultKeySecret(plugin)).not.toBeNull();

    // An unverified (legacy) key being dropped never deletes the shared secret.
    await releaseRemoteVaultKeySecret(plugin, VAULT_A, { remoteVaultKey: new Uint8Array([9, 9, 9]) });
    expect(await readLegacyRemoteVaultKeySecret(plugin)).not.toBeNull();

    // The shared secret is A's own verified key: a disconnect removes it too.
    await writeStoredRemoteVaultKeySecret(plugin, a);
    app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, encodeBase64(a.remoteVaultKey));
    await releaseRemoteVaultKeySecret(plugin, VAULT_A, a);
    expect(await readLegacyRemoteVaultKeySecret(plugin)).toBeNull();
  });
});
