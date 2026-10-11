import { describePathLimit, isPathWithinSyncLimits } from "./path-limits";

// Vault paths are portable between macOS/iOS/Android/Linux, but Windows rejects some
// names outright (e.g. a "?" in a sermon title). A device that cannot create a remote
// path must treat it like an excluded path: never write it, never propagate its absence
// as a delete, and leave the entry intact on the server for the devices that can.
// MAX_PATH is deliberately not enforced here; the byte limits in path-limits.ts apply
// on every platform.

export interface DevicePlatform {
  isWin: boolean;
}

// Answers "can this device hold this path?" for the sync predicate. Returns a short
// user-facing reason when it cannot, null when it can.
export interface DevicePathPolicy {
  describeUnwritable(path: string): string | null;
}

export type WindowsNameIssue =
  | { reason: "invalid_character"; component: string; character: string }
  | { reason: "trailing_dot_or_space"; component: string }
  | { reason: "reserved_name"; component: string };

const WINDOWS_INVALID_CHARACTER = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// <>:"|?* plus the C0 control characters U+0000–U+001F. Control characters are
// checked by code point so the pattern stays free of control-character escapes.
function findWindowsInvalidCharacter(component: string): string | null {
  const invalid = WINDOWS_INVALID_CHARACTER.exec(component);
  if (invalid) {
    return invalid[0];
  }
  for (const character of component) {
    if (character.charCodeAt(0) <= 0x1f) {
      return character;
    }
  }
  return null;
}

export function describeWindowsNameIssue(path: string): WindowsNameIssue | null {
  for (const component of path.split("/")) {
    if (!component) {
      continue;
    }

    const invalid = findWindowsInvalidCharacter(component);
    if (invalid) {
      return { reason: "invalid_character", component, character: invalid };
    }

    if (component.endsWith(".") || component.endsWith(" ")) {
      return { reason: "trailing_dot_or_space", component };
    }

    // Windows reserves the device name with any extension too ("con.md", "aux.tar.gz").
    const stem = component.split(".")[0] ?? "";
    if (WINDOWS_RESERVED_NAME.test(stem)) {
      return { reason: "reserved_name", component };
    }
  }

  return null;
}

export function formatWindowsNameIssue(issue: WindowsNameIssue): string {
  switch (issue.reason) {
    case "invalid_character":
      return issue.character.charCodeAt(0) < 0x20
        ? "contains a control character"
        : `contains "${issue.character}"`;
    case "trailing_dot_or_space":
      return "ends with a dot or space";
    case "reserved_name":
      return `uses the reserved name "${issue.component.split(".")[0]}"`;
  }
}

export function isPathWritableOnThisDevice(path: string, platform: DevicePlatform): boolean {
  if (!isPathWithinSyncLimits(path)) {
    return false;
  }

  return !platform.isWin || describeWindowsNameIssue(path) === null;
}

// Short, user-facing reason why this device cannot hold `path`; null when it can.
export function describeDeviceWriteIssue(
  path: string,
  platform: DevicePlatform,
): string | null {
  const limit = describePathLimit(path);
  if (!limit.ok) {
    const what = limit.reason === "filename_too_long" ? "File name" : "Path";
    return `${what} too long (${limit.byteSize} bytes, limit ${limit.limit})`;
  }

  if (platform.isWin) {
    const issue = describeWindowsNameIssue(path);
    if (issue) {
      return `Name not allowed on Windows (${formatWindowsNameIssue(issue)})`;
    }
  }

  return null;
}
