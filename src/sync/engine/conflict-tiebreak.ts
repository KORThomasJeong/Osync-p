export type ConflictWinner = "server" | "client";

export interface ConflictTiebreakInput {
  serverEditedAt: number | undefined;
  serverUpdatedAt: number | undefined;
  serverRevision: number;
  clientEditedAt: number | undefined;
  clientRevision: number;
}

export function decideConflictWinner(input: ConflictTiebreakInput): ConflictWinner {
  if (input.serverEditedAt !== undefined && input.clientEditedAt !== undefined) {
    return input.clientEditedAt > input.serverEditedAt ? "client" : "server";
  }
  if (input.clientEditedAt !== undefined && input.serverUpdatedAt !== undefined) {
    return input.clientEditedAt > input.serverUpdatedAt ? "client" : "server";
  }
  return input.clientRevision > input.serverRevision ? "client" : "server";
}
