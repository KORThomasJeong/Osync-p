import { describe, expect, it } from "vitest";

import { validateVaultPassword } from "./password-policy";

describe("vault password policy", () => {
  it("accepts long passphrases", () => {
    expect(validateVaultPassword("correct horse battery staple")).toEqual({ ok: true });
  });

  it("rejects short passwords", () => {
    expect(validateVaultPassword("vault-password")).toEqual({
      ok: false,
      message: "Password must be at least 16 characters.",
    });
  });

  it("rejects leading and trailing spaces", () => {
    expect(validateVaultPassword(" correct horse battery staple")).toEqual({
      ok: false,
      message: "Password cannot start or end with spaces.",
    });
  });

  it("rejects common weak passwords even when decorated", () => {
    expect(validateVaultPassword("vault-password")).toEqual({
      ok: false,
      message: "Password must be at least 16 characters.",
    });
    expect(validateVaultPassword("obsidian-vault")).toEqual({
      ok: false,
      message: "Password must be at least 16 characters.",
    });
    expect(validateVaultPassword("obsidian-vault-password")).toEqual({
      ok: false,
      message: "Password is too easy to guess. Use a longer passphrase.",
    });
    expect(validateVaultPassword("password1234567890")).toEqual({
      ok: false,
      message: "Password is too easy to guess. Use a longer passphrase.",
    });
  });

  it("rejects repeated characters and simple sequences", () => {
    expect(validateVaultPassword("aaaaaaaaaaaaaaaa")).toEqual({
      ok: false,
      message: "Password cannot be one repeated character.",
    });
    expect(validateVaultPassword("abcdefghijklmnop")).toEqual({
      ok: false,
      message: "Password cannot be a simple sequence.",
    });
  });
});
