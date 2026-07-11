import { classifyReconnectError } from "../remote/reconnect-error";
import { SyncHttpError } from "../../http/request";
import { SyncRealtimeError } from "../remote/realtime-types";

export interface SyncErrorEscalatorOptions {
  // How many times a non-actionable error may repeat before it is escalated to an
  // actionable, user-visible failure. Genuine transient network blips recover well
  // before this; a deterministic error (decrypt failure, unhandled reject code) keeps
  // repeating and trips it, so the user finally learns sync is stuck instead of the loop
  // retrying silently forever.
  threshold?: number;
}

export interface SyncErrorDecision {
  escalate: boolean;
  message: string;
}

const DEFAULT_THRESHOLD = 5;

export class SyncErrorEscalator {
  private readonly threshold: number;
  private consecutiveNonActionable = 0;

  constructor(options?: SyncErrorEscalatorOptions) {
    this.threshold = Math.max(1, options?.threshold ?? DEFAULT_THRESHOLD);
  }

  recordError(error: unknown): SyncErrorDecision {
    const classification = classifyReconnectError(error);
    if (classification.kind === "actionable") {
      this.consecutiveNonActionable = 0;
      return {
        escalate: true,
        message: classification.userMessage ?? "동기화에 실패했습니다.",
      };
    }

    this.consecutiveNonActionable += 1;
    if (this.consecutiveNonActionable >= this.threshold) {
      this.consecutiveNonActionable = 0;
      return {
        escalate: true,
        message: `동기화가 반복 실패하고 있습니다 (${describeCause(error)}). 콘솔 로그를 확인하세요.`,
      };
    }

    return { escalate: false, message: "" };
  }

  recordSuccess(): void {
    this.consecutiveNonActionable = 0;
  }
}

// A short, human-readable cause hint for the escalated notice. Not localized content —
// it names the error kind/code so the failure is distinguishable at a glance.
function describeCause(error: unknown): string {
  if (error instanceof SyncRealtimeError) {
    return `SyncRealtimeError: ${error.code}`;
  }
  if (error instanceof SyncHttpError) {
    return `SyncHttpError ${error.status}`;
  }
  if (error instanceof Error) {
    return error.name || "Error";
  }
  return "Unknown error";
}
