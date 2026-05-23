import { describe, expect, it } from "vitest";

import {
  decryptSyncBlob,
  decryptSyncMetadata,
  encryptSyncBlob,
  encryptSyncMetadata,
} from "./crypto";

const TEST_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const WRONG_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => 255 - index));
const TEST_METADATA_CONTEXT = {
  entryId: "entry-1",
  revision: 1,
  op: "upsert" as const,
  blobId: "blob-1",
};
const TEST_BLOB_CONTEXT = {
  blobId: "blob-1",
};

describe("sync crypto", () => {
  it("round-trips encrypted metadata", async () => {
    const encrypted = await encryptSyncMetadata(TEST_VAULT_KEY, {
      path: "Folder/note.md",
      hash: "hash-1",
    }, TEST_METADATA_CONTEXT);

    expect(encrypted).not.toContain("Folder/note.md");
    await expect(decryptSyncMetadata(TEST_VAULT_KEY, encrypted, TEST_METADATA_CONTEXT)).resolves.toEqual({
      path: "Folder/note.md",
      hash: "hash-1",
    });
  });

  it("round-trips encrypted blobs", async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const encrypted = await encryptSyncBlob(TEST_VAULT_KEY, plaintext, TEST_BLOB_CONTEXT);

    expect(encrypted).not.toEqual(plaintext);
    await expect(decryptSyncBlob(TEST_VAULT_KEY, encrypted, TEST_BLOB_CONTEXT)).resolves.toEqual(plaintext);
  });

  it("rejects the wrong vault key", async () => {
    const encrypted = await encryptSyncMetadata(TEST_VAULT_KEY, {
      path: "Folder/secret.md",
      hash: "hash-1",
    }, TEST_METADATA_CONTEXT);

    await expect(
      decryptSyncMetadata(WRONG_VAULT_KEY, encrypted, TEST_METADATA_CONTEXT),
    ).rejects.toThrow();
  });

  it("rejects metadata attached to the wrong entry context", async () => {
    const encrypted = await encryptSyncMetadata(
      TEST_VAULT_KEY,
      {
        path: "Folder/secret.md",
        hash: "hash-1",
      },
      TEST_METADATA_CONTEXT,
    );

    await expect(
      decryptSyncMetadata(TEST_VAULT_KEY, encrypted, {
        ...TEST_METADATA_CONTEXT,
        entryId: "entry-2",
      }),
    ).rejects.toThrow();
  });

  it("rejects blobs served under the wrong blob id", async () => {
    const encrypted = await encryptSyncBlob(
      TEST_VAULT_KEY,
      new Uint8Array([1, 2, 3]),
      TEST_BLOB_CONTEXT,
    );

    await expect(
      decryptSyncBlob(TEST_VAULT_KEY, encrypted, { blobId: "blob-2" }),
    ).rejects.toThrow();
  });
});
