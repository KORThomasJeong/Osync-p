import { describe, expect, it } from "vitest";

import { SyncHttpError } from "../../http/request";
import { SyncRealtimeError } from "../remote/realtime-types";
import { SyncErrorEscalator } from "./sync-error-escalator";

describe("SyncErrorEscalator", () => {
  it("escalates an actionable error immediately with its message", () => {
    const escalator = new SyncErrorEscalator({ threshold: 5 });
    const decision = escalator.recordError(new SyncHttpError(401, "no"));
    expect(decision.escalate).toBe(true);
    expect(decision.message).toBe("Your session expired. Sign in again to resume syncing.");
  });

  it("stays quiet while a non-actionable error is below the repeat threshold", () => {
    const escalator = new SyncErrorEscalator({ threshold: 5 });
    for (let i = 0; i < 4; i += 1) {
      const decision = escalator.recordError(new Error("decrypt failed"));
      expect(decision.escalate).toBe(false);
    }
  });

  it("escalates once a non-actionable error repeats up to the threshold", () => {
    const escalator = new SyncErrorEscalator({ threshold: 5 });
    let decision = escalator.recordError(new Error("decrypt failed"));
    for (let i = 0; i < 3; i += 1) {
      decision = escalator.recordError(new Error("decrypt failed"));
    }
    // 5th occurrence trips the threshold.
    decision = escalator.recordError(new Error("decrypt failed"));
    expect(decision.escalate).toBe(true);
    expect(decision.message).toContain("동기화");
    // Include a cause hint so the user/console can tell what kind of failure it is.
    expect(decision.message.toLowerCase()).toContain("error");
  });

  it("resets the repeat counter after a success, requiring the threshold again", () => {
    const escalator = new SyncErrorEscalator({ threshold: 3 });
    escalator.recordError(new Error("boom"));
    escalator.recordError(new Error("boom"));
    escalator.recordSuccess();
    // After success, two more failures must not escalate yet.
    expect(escalator.recordError(new Error("boom")).escalate).toBe(false);
    expect(escalator.recordError(new Error("boom")).escalate).toBe(false);
    expect(escalator.recordError(new Error("boom")).escalate).toBe(true);
  });

  it("surfaces a realtime error code in the escalated message", () => {
    const escalator = new SyncErrorEscalator({ threshold: 1 });
    const decision = escalator.recordError(
      new SyncRealtimeError("blob_not_found", "missing blob"),
    );
    expect(decision.escalate).toBe(true);
    expect(decision.message).toContain("blob_not_found");
  });
});
