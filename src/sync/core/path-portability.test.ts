import { describe, expect, it } from "vitest";

import {
  describeDeviceWriteIssue,
  describeWindowsNameIssue,
  formatWindowsNameIssue,
  isPathWritableOnThisDevice,
} from "./path-portability";

const WINDOWS = { isWin: true };
const MAC = { isWin: false };

describe("describeWindowsNameIssue", () => {
  it("accepts ordinary paths, including Korean and spaces inside names", () => {
    expect(describeWindowsNameIssue("Notes/2026/260719 너희는 나를.md")).toBeNull();
    expect(describeWindowsNameIssue("a.b/c d/e-f_g (1).md")).toBeNull();
  });

  it.each(["<", ">", ":", '"', "|", "?", "*"])("rejects the reserved character %s", (char) => {
    const path = `2026/260719 name${char}x.md`;
    expect(describeWindowsNameIssue(path)).toEqual({
      reason: "invalid_character",
      component: `260719 name${char}x.md`,
      character: char,
    });
  });

  it("reports the production case (trailing question mark in the title)", () => {
    expect(describeWindowsNameIssue("2026/260719 너희는 나를 누구라 하느냐?.md")).toEqual({
      reason: "invalid_character",
      component: "260719 너희는 나를 누구라 하느냐?.md",
      character: "?",
    });
  });

  it("checks every component, not only the file name", () => {
    expect(describeWindowsNameIssue("What?/note.md")).toEqual({
      reason: "invalid_character",
      component: "What?",
      character: "?",
    });
  });

  it("rejects control characters", () => {
    expect(describeWindowsNameIssue("a/b\u0001c.md")?.reason).toBe("invalid_character");
    expect(describeWindowsNameIssue("a/b\tc.md")?.reason).toBe("invalid_character");
  });

  it("rejects components ending in a dot or a space", () => {
    expect(describeWindowsNameIssue("Folder./note.md")).toEqual({
      reason: "trailing_dot_or_space",
      component: "Folder.",
    });
    expect(describeWindowsNameIssue("Folder /note.md")).toEqual({
      reason: "trailing_dot_or_space",
      component: "Folder ",
    });
    expect(describeWindowsNameIssue("Folder/note.md ")?.reason).toBe("trailing_dot_or_space");
  });

  it("rejects reserved device names case-insensitively, with or without an extension", () => {
    for (const name of ["CON", "prn", "Aux", "nul", "COM1", "com9", "LPT1", "lpt9"]) {
      expect(describeWindowsNameIssue(`x/${name}`)).toEqual({
        reason: "reserved_name",
        component: name,
      });
    }
    expect(describeWindowsNameIssue("con.md")?.reason).toBe("reserved_name");
    expect(describeWindowsNameIssue("Folder/Aux.tar.gz")?.reason).toBe("reserved_name");
  });

  it("does not flag names that merely contain a reserved word", () => {
    expect(describeWindowsNameIssue("console.md")).toBeNull();
    expect(describeWindowsNameIssue("COM10.md")).toBeNull();
    expect(describeWindowsNameIssue("COM0.md")).toBeNull();
    expect(describeWindowsNameIssue("my con.md")).toBeNull();
  });
});

describe("formatWindowsNameIssue", () => {
  it("describes each reason briefly", () => {
    expect(
      formatWindowsNameIssue({ reason: "invalid_character", component: "a?", character: "?" }),
    ).toBe('contains "?"');
    expect(formatWindowsNameIssue({ reason: "trailing_dot_or_space", component: "a." })).toBe(
      "ends with a dot or space",
    );
    expect(formatWindowsNameIssue({ reason: "reserved_name", component: "con.md" })).toBe(
      'uses the reserved name "con"',
    );
  });

  it("names control characters without printing them raw", () => {
    expect(
      formatWindowsNameIssue({ reason: "invalid_character", component: "a\u0001", character: "\u0001" }),
    ).toBe("contains a control character");
  });
});

describe("isPathWritableOnThisDevice", () => {
  const longName = `${"가".repeat(85)}.md`;

  it("on Windows rejects Windows-invalid names", () => {
    expect(isPathWritableOnThisDevice("a/what?.md", WINDOWS)).toBe(false);
    expect(isPathWritableOnThisDevice("a/ok.md", WINDOWS)).toBe(true);
  });

  it("elsewhere accepts Windows-invalid names", () => {
    expect(isPathWritableOnThisDevice("a/what?.md", MAC)).toBe(true);
  });

  it("applies the path limits on every platform", () => {
    expect(isPathWritableOnThisDevice(`a/${longName}`, MAC)).toBe(false);
    expect(isPathWritableOnThisDevice(`a/${longName}`, WINDOWS)).toBe(false);
  });
});

describe("describeDeviceWriteIssue", () => {
  it("returns a short reason for unwritable paths and null otherwise", () => {
    expect(describeDeviceWriteIssue("a/ok.md", WINDOWS)).toBeNull();
    expect(describeDeviceWriteIssue("a/what?.md", WINDOWS)).toBe(
      'Name not allowed on Windows (contains "?")',
    );
    expect(describeDeviceWriteIssue(`a/${"가".repeat(85)}.md`, MAC)).toBe(
      "File name too long (258 bytes, limit 250)",
    );
  });
});
