import { describe, expect, it } from "vitest";

import { DeleteBurstDetector } from "./delete-burst-detector";

describe("DeleteBurstDetector", () => {
  it("does not trip below the threshold within the window", () => {
    const detector = new DeleteBurstDetector({ windowMs: 1000, threshold: 5 });
    let now = 1_000;
    for (let i = 0; i < 4; i += 1) {
      expect(detector.record(now)).toBe(false);
      now += 10;
    }
  });

  it("trips once the threshold is reached within the window", () => {
    const detector = new DeleteBurstDetector({ windowMs: 1000, threshold: 5 });
    let now = 1_000;
    let tripped = false;
    for (let i = 0; i < 5; i += 1) {
      tripped = detector.record(now);
      now += 10;
    }
    expect(tripped).toBe(true);
  });

  it("does not trip when deletes are spread beyond the window", () => {
    const detector = new DeleteBurstDetector({ windowMs: 1000, threshold: 3 });
    expect(detector.record(0)).toBe(false);
    expect(detector.record(2_000)).toBe(false);
    expect(detector.record(4_000)).toBe(false);
  });

  it("resets its counter", () => {
    const detector = new DeleteBurstDetector({ windowMs: 1000, threshold: 2 });
    detector.record(1_000);
    detector.reset();
    expect(detector.record(1_010)).toBe(false);
  });
});
