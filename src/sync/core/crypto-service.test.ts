import { describe, expect, it, vi } from "vitest";
import { VaultKeyCryptoService } from "./crypto-service";

const TEST_KEY = new Uint8Array(32).fill(1);
const META_CTX = { entryId: "e1", revision: 1, op: "upsert" as const, blobId: "b1" };
const BLOB_CTX = { blobId: "b1" };

describe("VaultKeyCryptoService", () => {
  it("round-trips metadata", async () => {
    const svc = new VaultKeyCryptoService(() => TEST_KEY);
    const encrypted = await svc.encryptMetadata({ path: "note.md", hash: "h1" }, META_CTX);
    const decrypted = await svc.decryptMetadata(encrypted, META_CTX);
    expect(decrypted).toEqual({ path: "note.md", hash: "h1" });
  });

  it("round-trips blob", async () => {
    const svc = new VaultKeyCryptoService(() => TEST_KEY);
    const plain = new Uint8Array([1, 2, 3]);
    const enc = await svc.encryptBlob(plain, BLOB_CTX);
    const dec = await svc.decryptBlob(enc, BLOB_CTX);
    expect(dec).toEqual(plain);
  });

  it("calls getKey lazily on each operation", async () => {
    const getKey = vi.fn(() => TEST_KEY);
    const svc = new VaultKeyCryptoService(getKey);
    await svc.encryptMetadata({ path: "x.md", hash: "h" }, META_CTX);
    expect(getKey).toHaveBeenCalledOnce();
  });
});
