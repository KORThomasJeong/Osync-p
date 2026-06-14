import { describe, expect, it } from "vitest";

import { SyncHttpError } from "../../http/request";
import { RemoteVaultPasswordChangedError } from "../../remote-vault/types";
import { classifyReconnectError } from "./reconnect-error";
import { SyncRealtimeError } from "./realtime-types";

describe("classifyReconnectError", () => {
  it("classifies a 401 SyncHttpError as actionable", () => {
    const result = classifyReconnectError(new SyncHttpError(401, "no"));
    expect(result.kind).toBe("actionable");
    expect(result.userMessage).toBe("Your session expired. Sign in again to resume syncing.");
  });

  it("classifies a 403 SyncHttpError as actionable", () => {
    const result = classifyReconnectError(new SyncHttpError(403, "forbidden"));
    expect(result.kind).toBe("actionable");
    expect(result.userMessage).toBe("Your session expired. Sign in again to resume syncing.");
  });

  it("classifies a 500 SyncHttpError as transient", () => {
    const result = classifyReconnectError(new SyncHttpError(500, "boom"));
    expect(result.kind).toBe("transient");
    expect(result.userMessage).toBeUndefined();
  });

  it("classifies a 429 SyncHttpError as transient", () => {
    const result = classifyReconnectError(new SyncHttpError(429, "slow down"));
    expect(result.kind).toBe("transient");
  });

  it("classifies a network-level Error as transient", () => {
    const result = classifyReconnectError(new Error("Failed to fetch"));
    expect(result.kind).toBe("transient");
    expect(result.userMessage).toBeUndefined();
  });

  it("classifies a RemoteVaultPasswordChangedError as actionable", () => {
    const result = classifyReconnectError(new RemoteVaultPasswordChangedError());
    expect(result.kind).toBe("actionable");
    expect(result.userMessage).toBe(
      "Your vault password changed. Reconnect the vault to resume syncing.",
    );
  });

  it("classifies an auth-coded SyncRealtimeError as actionable", () => {
    const result = classifyReconnectError(
      new SyncRealtimeError("TOKEN_EXPIRED", "token expired"),
    );
    expect(result.kind).toBe("actionable");
    expect(result.userMessage).toBe("Your session expired. Sign in again to resume syncing.");
  });

  it("matches auth fragments case-insensitively and as substrings", () => {
    expect(classifyReconnectError(new SyncRealtimeError("unauthorized", "x")).kind).toBe(
      "actionable",
    );
    expect(classifyReconnectError(new SyncRealtimeError("Forbidden", "x")).kind).toBe(
      "actionable",
    );
    expect(classifyReconnectError(new SyncRealtimeError("invalid_token", "x")).kind).toBe(
      "actionable",
    );
    expect(classifyReconnectError(new SyncRealtimeError("session_auth_required", "x")).kind).toBe(
      "actionable",
    );
  });

  it("classifies a non-auth SyncRealtimeError as transient", () => {
    const result = classifyReconnectError(
      new SyncRealtimeError("base_revision_conflict", "conflict"),
    );
    expect(result.kind).toBe("transient");
    expect(result.userMessage).toBeUndefined();
  });

  it("classifies unknown values as transient", () => {
    expect(classifyReconnectError(undefined).kind).toBe("transient");
    expect(classifyReconnectError("just a string").kind).toBe("transient");
  });
});
