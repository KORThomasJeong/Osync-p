import {
  isLocalAheadStaleRevision,
  isPathAlreadyExistsRejection,
  isPullResolvableStaleRevision,
} from "./push-mutation-shared";

export type ConflictClassification =
  | "stale_needs_pull"
  | "local_ahead_conflict"
  | "path_already_exists_adopt"
  | "unhandled";

export interface ConflictResolutionPolicy {
  classify(error: unknown): ConflictClassification;
}

export class DefaultConflictResolutionPolicy implements ConflictResolutionPolicy {
  classify(error: unknown): ConflictClassification {
    if (isPullResolvableStaleRevision(error)) return "stale_needs_pull";
    if (isLocalAheadStaleRevision(error)) return "local_ahead_conflict";
    if (isPathAlreadyExistsRejection(error)) return "path_already_exists_adopt";
    return "unhandled";
  }
}
