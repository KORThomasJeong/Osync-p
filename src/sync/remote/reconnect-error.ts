import { SyncHttpError } from "../../http/request";
import { RemoteVaultPasswordChangedError } from "../../remote-vault/types";
import { SyncRealtimeError } from "./realtime-types";

export type ReconnectErrorKind = "transient" | "actionable";

export interface ReconnectErrorClassification {
  kind: ReconnectErrorKind;
  userMessage?: string;
}

const SESSION_EXPIRED_MESSAGE = "Your session expired. Sign in again to resume syncing.";
const PASSWORD_CHANGED_MESSAGE =
  "Your vault password changed. Reconnect the vault to resume syncing.";

const AUTH_CODE_FRAGMENTS = [
  "unauthorized",
  "forbidden",
  "invalid_token",
  "token_expired",
  "auth",
];

export function classifyReconnectError(error: unknown): ReconnectErrorClassification {
  if (error instanceof SyncHttpError) {
    if (error.status === 401 || error.status === 403) {
      return { kind: "actionable", userMessage: SESSION_EXPIRED_MESSAGE };
    }
    return { kind: "transient" };
  }

  if (error instanceof RemoteVaultPasswordChangedError) {
    return { kind: "actionable", userMessage: PASSWORD_CHANGED_MESSAGE };
  }

  if (error instanceof SyncRealtimeError) {
    const code = error.code.toLowerCase();
    if (AUTH_CODE_FRAGMENTS.some((fragment) => code.includes(fragment))) {
      return { kind: "actionable", userMessage: SESSION_EXPIRED_MESSAGE };
    }
    return { kind: "transient" };
  }

  return { kind: "transient" };
}
