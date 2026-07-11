export interface DeleteBurstDetectorOptions {
  windowMs: number;
  threshold: number;
}

// Detects a burst of local deletes arriving as individual vault events (e.g. a script or
// external tool removing many files while Obsidian is open). The batch mass-delete guard
// only runs during reconcile, so without this a burst pushes every deletion unguarded.
export class DeleteBurstDetector {
  private readonly windowMs: number;
  private readonly threshold: number;
  private timestamps: number[] = [];

  constructor(options: DeleteBurstDetectorOptions) {
    this.windowMs = options.windowMs;
    this.threshold = Math.max(1, options.threshold);
  }

  // Records a delete at `now` and returns true if the number of deletes within the
  // trailing window has reached the threshold.
  record(now: number): boolean {
    this.timestamps.push(now);
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    return this.timestamps.length >= this.threshold;
  }

  reset(): void {
    this.timestamps = [];
  }
}
