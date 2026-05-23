export interface PathLimits {
  maxPathBytes: number;
  maxFilenameBytes: number;
}

// iOS APFS allows up to 255 bytes per filename component and 1024 bytes total
// path. We leave headroom for the leading vault prefix the host attaches at
// runtime and for occasional surrogate pairs the encoder counts as 4 bytes.
export const DEFAULT_PATH_LIMITS: PathLimits = {
  maxPathBytes: 900,
  maxFilenameBytes: 250,
};

const encoder = new TextEncoder();

export function isPathWithinSyncLimits(
  path: string,
  limits: PathLimits = DEFAULT_PATH_LIMITS,
): boolean {
  return describePathLimit(path, limits).ok;
}

export type PathLimitReason = "path_too_long" | "filename_too_long";

export type PathLimitResult =
  | { ok: true }
  | { ok: false; reason: PathLimitReason; byteSize: number; limit: number };

export function describePathLimit(
  path: string,
  limits: PathLimits = DEFAULT_PATH_LIMITS,
): PathLimitResult {
  const filename = path.split("/").pop() ?? "";
  const filenameBytes = encoder.encode(filename).length;
  if (filenameBytes > limits.maxFilenameBytes) {
    return {
      ok: false,
      reason: "filename_too_long",
      byteSize: filenameBytes,
      limit: limits.maxFilenameBytes,
    };
  }

  const pathBytes = encoder.encode(path).length;
  if (pathBytes > limits.maxPathBytes) {
    return {
      ok: false,
      reason: "path_too_long",
      byteSize: pathBytes,
      limit: limits.maxPathBytes,
    };
  }

  return { ok: true };
}
