/** How long an in-flight resume may block newer resume triggers. */
export const RESUME_STALE_AFTER_MS = 45_000;

/**
 * Coalesces resume triggers (focus / visibilitychange / online) into one run,
 * without letting a hung run lock resume out forever.
 *
 * A run still in flight past `staleAfterMs` — e.g. a network request that
 * never settled after the phone switched networks in the background — no
 * longer blocks: the next trigger starts a fresh run. The stale run is left to
 * finish (it cannot be cancelled) but can no longer clear the newer run's slot.
 */
export class ResumeGate {
  private inFlight: { promise: Promise<void>; startedAt: number } | null = null;

  constructor(
    private readonly staleAfterMs: number = RESUME_STALE_AFTER_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Starts `run` unless a fresh run is already in flight. Returns whether it started. */
  trigger(run: () => Promise<void>, onError: (error: unknown) => void): boolean {
    if (this.inFlight && this.now() - this.inFlight.startedAt < this.staleAfterMs) {
      return false;
    }

    const entry: { promise: Promise<void>; startedAt: number } = {
      promise: Promise.resolve(),
      startedAt: this.now(),
    };
    this.inFlight = entry;
    entry.promise = Promise.resolve()
      .then(run)
      .catch(onError)
      .finally(() => {
        if (this.inFlight === entry) {
          this.inFlight = null;
        }
      });
    return true;
  }

  /** The current in-flight run, for callers/tests that need to await it. */
  get current(): Promise<void> | null {
    return this.inFlight?.promise ?? null;
  }
}
