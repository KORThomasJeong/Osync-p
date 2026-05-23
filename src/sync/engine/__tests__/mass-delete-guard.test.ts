import { describe, expect, it } from "vitest";
import {
  MassDeleteGuardError,
  shouldTripMassDeleteGuard,
} from "../mass-delete-guard";

describe("shouldTripMassDeleteGuard", () => {
  it("does not trip when delete count is below 50 and ratio is below 0.3", () => {
    expect(shouldTripMassDeleteGuard({ deleteCount: 49, knownEntryCount: 200 })).toBe(false);
  });

  it("trips when delete count >= 50 even if ratio is small", () => {
    expect(shouldTripMassDeleteGuard({ deleteCount: 50, knownEntryCount: 1000 })).toBe(true);
  });

  it("trips when ratio >= 0.3 even if absolute < 50", () => {
    expect(shouldTripMassDeleteGuard({ deleteCount: 7, knownEntryCount: 20 })).toBe(true);
  });

  it("does not trip on empty store (no known entries)", () => {
    expect(shouldTripMassDeleteGuard({ deleteCount: 0, knownEntryCount: 0 })).toBe(false);
  });

  it("does not trip when deleteCount < 5 even if ratio is high (avoids tripping tiny vaults)", () => {
    expect(shouldTripMassDeleteGuard({ deleteCount: 1, knownEntryCount: 1 })).toBe(false);
    expect(shouldTripMassDeleteGuard({ deleteCount: 4, knownEntryCount: 4 })).toBe(false);
  });

  it("trips when deleteCount >= 5 and ratio >= 0.3", () => {
    expect(shouldTripMassDeleteGuard({ deleteCount: 5, knownEntryCount: 10 })).toBe(true);
  });

  it("MassDeleteGuardError carries deleteCount and knownEntryCount", () => {
    const error = new MassDeleteGuardError({ deleteCount: 100, knownEntryCount: 200 });
    expect(error.deleteCount).toBe(100);
    expect(error.knownEntryCount).toBe(200);
    expect(error.name).toBe("MassDeleteGuardError");
  });
});
