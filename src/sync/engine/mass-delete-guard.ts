export const MASS_DELETE_GUARD_ABSOLUTE_FLOOR = 50;
export const MASS_DELETE_GUARD_RATIO = 0.3;
export const MASS_DELETE_GUARD_RATIO_MIN_COUNT = 5;

export interface MassDeleteGuardCounts {
  deleteCount: number;
  knownEntryCount: number;
}

export function shouldTripMassDeleteGuard(counts: MassDeleteGuardCounts): boolean {
  if (counts.knownEntryCount === 0) {
    return false;
  }
  if (counts.deleteCount >= MASS_DELETE_GUARD_ABSOLUTE_FLOOR) {
    return true;
  }
  if (counts.deleteCount < MASS_DELETE_GUARD_RATIO_MIN_COUNT) {
    return false;
  }
  return counts.deleteCount / counts.knownEntryCount >= MASS_DELETE_GUARD_RATIO;
}

export class MassDeleteGuardError extends Error {
  readonly deleteCount: number;
  readonly knownEntryCount: number;

  constructor(counts: MassDeleteGuardCounts) {
    super(
      `Mass delete guard tripped: ${counts.deleteCount} of ${counts.knownEntryCount} entries would be deleted.`,
    );
    this.name = "MassDeleteGuardError";
    this.deleteCount = counts.deleteCount;
    this.knownEntryCount = counts.knownEntryCount;
  }
}
