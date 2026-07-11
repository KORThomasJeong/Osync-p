import { describe, expect, it } from "vitest";

import { SyncEventGate } from "./event-gate";

describe("SyncEventGate replay of events dropped during suppression", () => {
  it("replays a path that saw a real event while it was suppressed, once the window closes", async () => {
    const replayed: string[] = [];
    const gate = new SyncEventGate((path) => replayed.push(path));

    await gate.suppressPaths(["Notes/a.md"], async () => {
      // A user edit lands on the same path mid-pull; the recorder drops it after
      // noting it on the gate.
      expect(gate.isSuppressed("Notes/a.md")).toBe(true);
      gate.noteSuppressedEvent("Notes/a.md");
    });

    expect(replayed).toEqual(["Notes/a.md"]);
  });

  it("does not replay a path that saw no event during suppression", async () => {
    const replayed: string[] = [];
    const gate = new SyncEventGate((path) => replayed.push(path));

    await gate.suppressPaths(["Notes/a.md"], async () => {});

    expect(replayed).toEqual([]);
  });

  it("ignores a noted event for a path that is not currently suppressed", async () => {
    const replayed: string[] = [];
    const gate = new SyncEventGate((path) => replayed.push(path));

    gate.noteSuppressedEvent("Notes/a.md"); // not inside a suppression window

    // Opening and closing an unrelated window must not replay it.
    await gate.suppressPaths(["Notes/b.md"], async () => {});
    expect(replayed).toEqual([]);
  });

  it("replays only after the outermost nested window closes", async () => {
    const replayed: string[] = [];
    const gate = new SyncEventGate((path) => replayed.push(path));

    await gate.suppressPaths(["Notes/a.md"], async () => {
      await gate.suppressPaths(["Notes/a.md"], async () => {
        gate.noteSuppressedEvent("Notes/a.md");
        expect(replayed).toEqual([]); // inner close: still suppressed by outer
      });
      expect(replayed).toEqual([]); // outer still open
    });

    expect(replayed).toEqual(["Notes/a.md"]);
  });

  it("works without a replay callback (no-op)", async () => {
    const gate = new SyncEventGate();
    await expect(
      gate.suppressPaths(["Notes/a.md"], async () => {
        gate.noteSuppressedEvent("Notes/a.md");
      }),
    ).resolves.toBeUndefined();
  });
});
