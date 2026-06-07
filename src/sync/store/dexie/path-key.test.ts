import { describe, expect, it } from "vitest";

import { samePathKey, toPathKey } from "./path-key";

describe("toPathKey", () => {
  it("is idempotent", () => {
    const nfd = "노트/회의록.md".normalize("NFD");

    expect(toPathKey(toPathKey(nfd))).toBe(toPathKey(nfd));
  });

  it("normalizes NFD input to NFC output", () => {
    const nfd = "회의록.md".normalize("NFD");

    expect(toPathKey(nfd)).toBe("회의록.md".normalize("NFC"));
  });

  it("preserves ASCII / separators", () => {
    expect(toPathKey("Folder/Sub/note.md")).toBe("Folder/Sub/note.md");
  });

  it("produces equal keys for NFD and NFC forms of the same path", () => {
    const nfd = "노트/회의록.md".normalize("NFD");
    const nfc = "노트/회의록.md".normalize("NFC");

    expect(nfd).not.toBe(nfc);
    expect(toPathKey(nfd)).toBe(toPathKey(nfc));
  });
});

describe("samePathKey", () => {
  it("treats NFD and NFC forms as equal", () => {
    const nfd = "회의록.md".normalize("NFD");
    const nfc = "회의록.md".normalize("NFC");

    expect(samePathKey(nfd, nfc)).toBe(true);
  });
});
