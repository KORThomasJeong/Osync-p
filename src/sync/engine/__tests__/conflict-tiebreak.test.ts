import { describe, expect, it } from "vitest";

import { decideConflictWinner } from "../conflict-tiebreak";

describe("decideConflictWinner", () => {
  it("server wins when serverEditedAt > clientEditedAt", () => {
    expect(
      decideConflictWinner({
        serverEditedAt: 200,
        serverUpdatedAt: 100,
        serverRevision: 2,
        clientEditedAt: 100,
        clientRevision: 1,
      }),
    ).toBe("server");
  });

  it("client wins when clientEditedAt > serverEditedAt", () => {
    expect(
      decideConflictWinner({
        serverEditedAt: 100,
        serverUpdatedAt: 100,
        serverRevision: 2,
        clientEditedAt: 200,
        clientRevision: 1,
      }),
    ).toBe("client");
  });

  it("falls back to serverUpdatedAt when serverEditedAt missing", () => {
    expect(
      decideConflictWinner({
        serverEditedAt: undefined,
        serverUpdatedAt: 200,
        serverRevision: 2,
        clientEditedAt: 100,
        clientRevision: 1,
      }),
    ).toBe("server");
  });

  it("falls back to revision when neither side has editedAt or updatedAt", () => {
    expect(
      decideConflictWinner({
        serverEditedAt: undefined,
        serverUpdatedAt: undefined,
        serverRevision: 2,
        clientEditedAt: undefined,
        clientRevision: 1,
      }),
    ).toBe("server");
  });

  it("server wins on exact tie (deterministic)", () => {
    expect(
      decideConflictWinner({
        serverEditedAt: 100,
        serverUpdatedAt: 100,
        serverRevision: 1,
        clientEditedAt: 100,
        clientRevision: 1,
      }),
    ).toBe("server");
  });

  it("client wins by revision when no timestamps available", () => {
    expect(
      decideConflictWinner({
        serverEditedAt: undefined,
        serverUpdatedAt: undefined,
        serverRevision: 1,
        clientEditedAt: undefined,
        clientRevision: 2,
      }),
    ).toBe("client");
  });
});
