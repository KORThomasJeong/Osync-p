import { describe, expect, it } from "vitest";

import {
  computeVaultKeyFingerprint,
  createPasswordWrappedRemoteVaultKey,
  rewrapRemoteVaultKey,
  unwrapRemoteVaultKeyWithPassword,
} from "./crypto";

describe("vault crypto", () => {
  it("round-trips a password-wrapped vault key", async () => {
    const created = await createPasswordWrappedRemoteVaultKey("correct horse battery staple", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });
    const unwrapped = await unwrapRemoteVaultKeyWithPassword(
      "correct horse battery staple",
      created.envelope,
    );

    expect(Buffer.from(unwrapped).toString("base64")).toBe(
      Buffer.from(created.remoteVaultKey).toString("base64"),
    );
    expect(created.envelope.wrap.algorithm).toBe("aes-256-gcm");
    expect(created.envelope.kdf.name).toBe("argon2id");
  });

  it("rejects the wrong password", async () => {
    const created = await createPasswordWrappedRemoteVaultKey("vault-password", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });

    await expect(
      unwrapRemoteVaultKeyWithPassword("wrong-password", created.envelope),
    ).rejects.toThrow();
  });

  it("rejects passwords with leading or trailing spaces", async () => {
    await expect(
      createPasswordWrappedRemoteVaultKey(" vault-password", {
        kdfOverrides: {
          memoryKiB: 8,
          iterations: 1,
          parallelism: 1,
        },
      }),
    ).rejects.toThrow("Password cannot start or end with spaces.");
  });

  it("rewraps an existing vault key and round-trips with the new password", async () => {
    const vaultKey = new Uint8Array(32);
    for (let i = 0; i < vaultKey.byteLength; i += 1) {
      vaultKey[i] = i;
    }

    const envelope = await rewrapRemoteVaultKey(vaultKey, "new-password", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });

    const unwrapped = await unwrapRemoteVaultKeyWithPassword("new-password", envelope);
    expect(Buffer.from(unwrapped).toString("base64")).toBe(
      Buffer.from(vaultKey).toString("base64"),
    );
  });

  it("rewrapRemoteVaultKey rejects keys of the wrong length", async () => {
    const tooShort = new Uint8Array(16);
    await expect(
      rewrapRemoteVaultKey(tooShort, "any-password", {
        kdfOverrides: {
          memoryKiB: 8,
          iterations: 1,
          parallelism: 1,
        },
      }),
    ).rejects.toThrow(/32-byte vault key/);
  });

  it("computeVaultKeyFingerprint is deterministic and distinguishes different keys", async () => {
    const keyA = new Uint8Array(32);
    for (let i = 0; i < keyA.byteLength; i += 1) {
      keyA[i] = i;
    }
    const keyB = new Uint8Array(32);
    for (let i = 0; i < keyB.byteLength; i += 1) {
      keyB[i] = 255 - i;
    }

    const fingerprintA1 = await computeVaultKeyFingerprint(keyA);
    const fingerprintA2 = await computeVaultKeyFingerprint(keyA);
    const fingerprintB = await computeVaultKeyFingerprint(keyB);

    expect(fingerprintA1).toBe(fingerprintA2);
    expect(fingerprintA1).not.toBe(fingerprintB);
  });

  it("rewrapping preserves the vault key fingerprint", async () => {
    const created = await createPasswordWrappedRemoteVaultKey("original-password", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });
    const originalFingerprint = await computeVaultKeyFingerprint(created.remoteVaultKey);

    const newEnvelope = await rewrapRemoteVaultKey(created.remoteVaultKey, "new-password", {
      kdfOverrides: {
        memoryKiB: 8,
        iterations: 1,
        parallelism: 1,
      },
    });
    const unwrapped = await unwrapRemoteVaultKeyWithPassword("new-password", newEnvelope);
    const rewrappedFingerprint = await computeVaultKeyFingerprint(unwrapped);

    expect(rewrappedFingerprint).toBe(originalFingerprint);
  });
});
