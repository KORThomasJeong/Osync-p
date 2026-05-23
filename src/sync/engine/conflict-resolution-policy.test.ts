import { describe, expect, it } from "vitest";
import { DefaultConflictResolutionPolicy } from "./conflict-resolution-policy";

describe("DefaultConflictResolutionPolicy", () => {
  const policy = new DefaultConflictResolutionPolicy();

  // isPullResolvableStaleRevision: expectedBaseRevision > receivedBaseRevision
  // → 서버가 더 낮은 revision을 기대함 → pull하면 해소 가능
  it("stale_revision + expectedBaseRevision > receivedBaseRevision → stale_needs_pull 반환", () => {
    const error = {
      code: "stale_revision",
      expectedBaseRevision: 10,
      receivedBaseRevision: 5,
    };
    const result = policy.classify(error);
    expect(result).toBe("stale_needs_pull");
  });

  // details 필드를 통해 revision 정보를 갖는 경우도 지원
  it("stale_revision + details.expectedBaseRevision > details.receivedBaseRevision → stale_needs_pull 반환", () => {
    const error = {
      code: "stale_revision",
      details: {
        expectedBaseRevision: 10,
        receivedBaseRevision: 3,
      },
    };
    const result = policy.classify(error);
    expect(result).toBe("stale_needs_pull");
  });

  // isLocalAheadStaleRevision: expectedBaseRevision < receivedBaseRevision
  // → 로컬이 서버보다 앞서 있음 → 충돌 처리 필요
  it("stale_revision + expectedBaseRevision < receivedBaseRevision → local_ahead_conflict 반환", () => {
    const error = {
      code: "stale_revision",
      expectedBaseRevision: 3,
      receivedBaseRevision: 10,
    };
    const result = policy.classify(error);
    expect(result).toBe("local_ahead_conflict");
  });

  it("stale_revision + details.expectedBaseRevision < details.receivedBaseRevision → local_ahead_conflict 반환", () => {
    const error = {
      code: "stale_revision",
      details: {
        expectedBaseRevision: 2,
        receivedBaseRevision: 8,
      },
    };
    const result = policy.classify(error);
    expect(result).toBe("local_ahead_conflict");
  });

  // code가 stale_revision이지만 revision 숫자 정보가 없는 경우
  it("stale_revision이지만 revision 정보 없음 → unhandled 반환", () => {
    const error = { code: "stale_revision" };
    const result = policy.classify(error);
    expect(result).toBe("unhandled");
  });

  // 일반 Error 객체
  it("일반 Error 객체 → unhandled 반환", () => {
    const error = new Error("network error");
    const result = policy.classify(error);
    expect(result).toBe("unhandled");
  });

  // 다른 code의 에러
  it("code가 stale_revision이 아닌 에러 → unhandled 반환", () => {
    const error = { code: "unauthorized", message: "auth failed" };
    const result = policy.classify(error);
    expect(result).toBe("unhandled");
  });

  // null, undefined
  it("null 에러 → unhandled 반환", () => {
    expect(policy.classify(null)).toBe("unhandled");
  });

  it("undefined 에러 → unhandled 반환", () => {
    expect(policy.classify(undefined)).toBe("unhandled");
  });
});
