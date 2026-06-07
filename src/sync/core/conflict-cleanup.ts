import { SYNC_CONFLICT_FILE_PATTERN } from "./file-rules";

export interface ConflictCopyEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface ConflictCleanupScanner {
  listFiles(): Promise<Array<{ path: string; size: number; mtime: number }>>;
}

export interface ConflictCleanupRemover {
  remove(path: string): Promise<void>;
}

export interface DeleteFailure {
  path: string;
  error: string;
}

export interface DeleteResult {
  successCount: number;
  failures: DeleteFailure[];
}

export interface DeleteOptions {
  chunkSize?: number;
  onProgress?: (done: number, total: number) => void;
}

const DEFAULT_CHUNK_SIZE = 50;

export async function findConflictCopies(
  scanner: ConflictCleanupScanner,
): Promise<ConflictCopyEntry[]> {
  const files = await scanner.listFiles();
  const matches = files.filter((file) =>
    SYNC_CONFLICT_FILE_PATTERN.test(file.path),
  );
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches.map((file) => ({
    path: file.path,
    size: file.size,
    mtime: file.mtime,
  }));
}

export async function deleteConflictCopies(
  remover: ConflictCleanupRemover,
  paths: string[],
  options: DeleteOptions = {},
): Promise<DeleteResult> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const failures: DeleteFailure[] = [];
  let successCount = 0;
  let done = 0;

  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map((path) => remover.remove(path)),
    );
    for (let j = 0; j < results.length; j += 1) {
      const outcome = results[j];
      const path = chunk[j];
      if (outcome.status === "fulfilled") {
        successCount += 1;
      } else {
        failures.push({
          path,
          error:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
        });
      }
    }
    done += chunk.length;
    options.onProgress?.(done, paths.length);
  }

  return { successCount, failures };
}
