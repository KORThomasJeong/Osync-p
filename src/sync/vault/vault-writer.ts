export interface SyncVaultWriter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, content: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export async function writeVaultBytes(
  writer: Pick<SyncVaultWriter, "exists" | "mkdir" | "writeText" | "writeBinary">,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await ensureParentDirectories(writer, path);
  if (isMarkdownPath(path)) {
    await writer.writeText(path, new TextDecoder().decode(bytes));
    return;
  }

  await writer.writeBinary(path, bytes);
}

export async function writeVaultBinary(
  writer: Pick<SyncVaultWriter, "exists" | "mkdir" | "writeBinary">,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await ensureParentDirectories(writer, path);
  await writer.writeBinary(path, bytes);
}

export async function writeVaultText(
  writer: Pick<SyncVaultWriter, "exists" | "mkdir" | "writeText">,
  path: string,
  content: string,
): Promise<void> {
  await ensureParentDirectories(writer, path);
  await writer.writeText(path, content);
}

export async function removeVaultPathIfExists(
  writer: Pick<SyncVaultWriter, "exists" | "remove">,
  path: string | null | undefined,
): Promise<boolean> {
  if (!path || !(await writer.exists(path))) {
    return false;
  }

  await writer.remove(path);
  return true;
}

export async function ensureParentDirectories(
  writer: Pick<SyncVaultWriter, "exists" | "mkdir">,
  path: string,
): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    if (!part) {
      continue;
    }

    current = current ? `${current}/${part}` : part;
    if (!(await writer.exists(current))) {
      await writer.mkdir(current);
    }
  }
}

export async function ensureParentDirectoriesBatch(
  writer: Pick<SyncVaultWriter, "exists" | "mkdir">,
  paths: readonly string[],
): Promise<void> {
  const uniqueDirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      if (!part) {
        continue;
      }

      current = current ? `${current}/${part}` : part;
      uniqueDirs.add(current);
    }
  }

  const sorted = Array.from(uniqueDirs).sort((a, b) => {
    const depthA = a.split("/").length;
    const depthB = b.split("/").length;
    if (depthA !== depthB) {
      return depthA - depthB;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });

  for (const dir of sorted) {
    if (!(await writer.exists(dir))) {
      await writer.mkdir(dir);
    }
  }
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}
