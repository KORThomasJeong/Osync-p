import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";

import {
  getOrCreateLocalVaultId,
  readLocalVaultId,
  readOwnedLocalVaultIds,
  recordOwnedLocalVaultId,
} from "./local-vault";

function makePlugin(initial: Record<string, unknown> = {}): Plugin {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    app: {
      loadLocalStorage: (key: string) => store.get(key) ?? null,
      saveLocalStorage: (key: string, value: unknown) => {
        if (value === null) store.delete(key);
        else store.set(key, value);
      },
    },
  } as unknown as Plugin;
}

describe("owned localVaultId history", () => {
  it("records a newly created localVaultId in the owned set", () => {
    const plugin = makePlugin();
    const id = getOrCreateLocalVaultId(plugin);
    expect(readOwnedLocalVaultIds(plugin)).toContain(id);
  });

  it("includes a pre-existing localVaultId in the owned set on read", () => {
    // A vault that predates owned-set tracking still has its localVaultId in
    // localStorage; it must be treated as owned so cleanup can remove its stale stores.
    const plugin = makePlugin({ "osync.localVaultId": "legacy-id" });
    expect(readOwnedLocalVaultIds(plugin)).toContain("legacy-id");
  });

  it("accumulates multiple owned ids without duplicates", () => {
    const plugin = makePlugin();
    recordOwnedLocalVaultId(plugin, "id-1");
    recordOwnedLocalVaultId(plugin, "id-2");
    recordOwnedLocalVaultId(plugin, "id-1");
    expect(readOwnedLocalVaultIds(plugin).sort()).toEqual(["id-1", "id-2"]);
  });

  it("keeps prior owned ids when a new localVaultId is created after a reset", () => {
    const plugin = makePlugin();
    recordOwnedLocalVaultId(plugin, "old-id");
    // Simulate reset: clear the active id, then create a fresh one.
    const fresh = getOrCreateLocalVaultId(plugin);
    const owned = readOwnedLocalVaultIds(plugin);
    expect(owned).toContain("old-id");
    expect(owned).toContain(fresh);
  });

  it("returns an empty list when nothing has been owned", () => {
    const plugin = makePlugin();
    expect(readOwnedLocalVaultIds(plugin)).toEqual([]);
  });

  it("still returns the created id from getOrCreateLocalVaultId", () => {
    const plugin = makePlugin();
    const id = getOrCreateLocalVaultId(plugin);
    expect(id).toBeTruthy();
    expect(readLocalVaultId(plugin)).toBe(id);
  });
});
