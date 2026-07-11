export interface SyncEventGateLike {
  isSuppressed(path: string): boolean;
  noteSuppressedEvent(path: string): void;
  suppressPaths<T>(
    paths: ReadonlyArray<string | null | undefined>,
    action: () => Promise<T>,
  ): Promise<T>;
}

export class SyncEventGate implements SyncEventGateLike {
  private readonly counts = new Map<string, number>();
  // Paths that saw a real vault event while suppressed. A pull suppresses a path only
  // for the duration of its own disk write; a genuine user edit that lands in that
  // window is dropped by the recorder. We remember it here and replay it once the
  // window closes so the edit is not silently lost until the next full reconcile.
  private readonly pendingReplay = new Set<string>();

  constructor(private readonly onReplay?: (path: string) => void) {}

  isSuppressed(path: string): boolean {
    return this.counts.has(path);
  }

  noteSuppressedEvent(path: string): void {
    if (this.counts.has(path)) {
      this.pendingReplay.add(path);
    }
  }

  async suppressPaths<T>(
    paths: ReadonlyArray<string | null | undefined>,
    action: () => Promise<T>,
  ): Promise<T> {
    const uniquePaths = [...new Set(paths.filter(isNonEmptyPath))];
    for (const path of uniquePaths) {
      this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
    }

    try {
      return await action();
    } finally {
      const toReplay: string[] = [];
      for (const path of uniquePaths) {
        const next = (this.counts.get(path) ?? 1) - 1;
        if (next <= 0) {
          this.counts.delete(path);
          if (this.pendingReplay.has(path)) {
            this.pendingReplay.delete(path);
            toReplay.push(path);
          }
        } else {
          this.counts.set(path, next);
        }
      }
      // Replay after all counts are settled so a replay handler that re-enters the gate
      // sees a consistent state.
      for (const path of toReplay) {
        this.onReplay?.(path);
      }
    }
  }
}

function isNonEmptyPath(path: string | null | undefined): path is string {
  return typeof path === "string" && path.trim().length > 0;
}
