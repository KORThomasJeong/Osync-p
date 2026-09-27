import { describe, expect, it, vi } from "vitest";

import { ResumeGate } from "./resume-gate";

function makeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ResumeGate", () => {
  it("dedups triggers while a fresh run is in flight", async () => {
    const clock = makeClock();
    const gate = new ResumeGate(45_000, clock.now);
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    expect(gate.trigger(run, () => {})).toBe(true);
    clock.advance(10_000);
    expect(gate.trigger(run, () => {})).toBe(false);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();

    release();
    await gate.current;
    expect(gate.current).toBeNull();
    expect(gate.trigger(run, () => {})).toBe(true);
  });

  it("unblocks a new resume once the in-flight run is stale (hung forever)", async () => {
    const clock = makeClock();
    const gate = new ResumeGate(45_000, clock.now);
    const hung = vi.fn(() => new Promise<void>(() => {}));
    const fresh = vi.fn(async () => {});

    gate.trigger(hung, () => {});
    clock.advance(44_999);
    expect(gate.trigger(fresh, () => {})).toBe(false);
    clock.advance(1);
    expect(gate.trigger(fresh, () => {})).toBe(true);
    await gate.current;
    expect(fresh).toHaveBeenCalledOnce();
  });

  it("a stale run finishing late does not clear the newer run's slot", async () => {
    const clock = makeClock();
    const gate = new ResumeGate(45_000, clock.now);
    let releaseStale!: () => void;
    gate.trigger(
      () =>
        new Promise<void>((resolve) => {
          releaseStale = resolve;
        }),
      () => {},
    );
    const stale = gate.current;
    await Promise.resolve(); // let the stale run start
    clock.advance(45_000);
    gate.trigger(() => new Promise<void>(() => {}), () => {});
    const newer = gate.current;

    releaseStale();
    await stale;

    expect(gate.current).toBe(newer);
    expect(gate.trigger(async () => {}, () => {})).toBe(false);
  });

  it("routes run failures to onError and frees the slot", async () => {
    const gate = new ResumeGate();
    const onError = vi.fn();

    gate.trigger(async () => {
      throw new Error("boom");
    }, onError);
    await gate.current;

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    expect(gate.current).toBeNull();
  });
});
