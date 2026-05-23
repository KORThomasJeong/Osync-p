import { describe, expect, it } from "vitest";

import { derivePathToken } from "../crypto";

describe("derivePathToken", () => {
  it("returns same token for same vault key + same path", async () => {
    const key = new Uint8Array(32).fill(1);
    const t1 = await derivePathToken(key, "notes/a.md");
    const t2 = await derivePathToken(key, "notes/a.md");
    expect(t1).toBe(t2);
  });

  it("returns different tokens for different paths", async () => {
    const key = new Uint8Array(32).fill(1);
    expect(await derivePathToken(key, "a.md")).not.toBe(
      await derivePathToken(key, "b.md"),
    );
  });

  it("returns different tokens for different vault keys", async () => {
    const k1 = new Uint8Array(32).fill(1);
    const k2 = new Uint8Array(32).fill(2);
    expect(await derivePathToken(k1, "a.md")).not.toBe(
      await derivePathToken(k2, "a.md"),
    );
  });

  it("output is 32 hex chars (16 bytes)", async () => {
    const key = new Uint8Array(32).fill(1);
    expect(await derivePathToken(key, "x")).toMatch(/^[0-9a-f]{32}$/);
  });
});
