import type { Plugin } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";

import { resetObsidianMocks, setMissingIconIds } from "../test-stubs/obsidian";
import type { UserVisibleSyncState } from "../sync/runtime/user-visible-status";
import { registerOsyncCommands, type OsyncCommandController } from "./commands";
import { OsyncSyncStatusRibbon } from "./sync-status-ribbon";

function createRibbonElement() {
  const listeners = new Map<string, () => void>();
  return {
    iconId: undefined as string | undefined,
    attrs: new Map<string, string>(),
    classes: [] as string[],
    listeners,
    setAttr(name: string, value: string) {
      this.attrs.set(name, value);
    },
    addClass(cls: string) {
      this.classes.push(cls);
    },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
  };
}

describe("OsyncSyncStatusRibbon", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  function setup(initialState: UserVisibleSyncState) {
    const element = createRibbonElement();
    const added: { icon: string; title: string; callback: () => void }[] = [];
    const plugin = {
      addRibbonIcon: (icon: string, title: string, callback: () => void) => {
        added.push({ icon, title, callback });
        element.iconId = icon;
        return element;
      },
    } as unknown as Plugin;
    const state = {
      state: initialState,
      label: "Sync: up to date 100%",
      lastVerifiedAt: Date.now() - 2 * 60_000 as number | null,
    };
    let opened = 0;
    const ribbon = new OsyncSyncStatusRibbon(
      plugin,
      {
        getSyncState: () => state.state,
        getSyncStatusLabel: () => state.label,
        getLastVerifiedAt: () => state.lastVerifiedAt,
      },
      () => {
        opened += 1;
      },
    );
    ribbon.initialize();
    return { element, added, state, ribbon, opened: () => opened };
  }

  it("adds a ribbon icon reflecting the state with a status tooltip", () => {
    const { element, added, opened } = setup("up_to_date");
    expect(added).toHaveLength(1);
    expect(added[0]?.icon).toBe("cloud-check");
    expect(element.attrs.get("aria-label")).toBe(
      "Sync: up to date 100%\nLast server check: 2 min ago",
    );
    added[0]?.callback();
    expect(opened()).toBe(1);
  });

  it("updates the icon and tooltip on refresh", () => {
    const { element, state, ribbon } = setup("up_to_date");
    state.state = "attention_needed";
    state.label = "Sync: attention needed 0%";
    state.lastVerifiedAt = null;
    ribbon.refresh();
    expect(element.iconId).toBe("alert-triangle");
    expect(element.attrs.get("aria-label")).toBe(
      "Sync: attention needed 0%\nLast server check: never",
    );

    state.state = "reconnecting";
    ribbon.refresh();
    expect(element.iconId).toBe("cloud-off");
    state.state = "checking";
    ribbon.refresh();
    expect(element.iconId).toBe("refresh-cw");
  });

  it("recomputes the tooltip on hover", () => {
    const { element, state } = setup("up_to_date");
    state.lastVerifiedAt = Date.now() - 9 * 60_000;
    element.listeners.get("mouseenter")?.();
    expect(element.attrs.get("aria-label")).toBe(
      "Sync: up to date 100%\nLast server check: 9 min ago",
    );
  });

  it("uses the fallback icon when cloud-check is missing", () => {
    setMissingIconIds(["cloud-check"]);
    const { added } = setup("up_to_date");
    expect(added[0]?.icon).toBe("check-circle");
  });
});

describe("open-sync-status command", () => {
  it("is registered and opens the sync status modal", () => {
    const commands: { id: string; name: string; callback?: () => unknown }[] = [];
    const plugin = {
      app: {},
      addCommand: (command: { id: string; name: string; callback?: () => unknown }) => {
        commands.push(command);
      },
    } as unknown as Plugin;
    let opened = 0;
    const controller = new Proxy(
      {
        openSyncStatus: () => {
          opened += 1;
        },
      },
      {
        get: (target, prop) =>
          prop in target ? target[prop as keyof typeof target] : () => undefined,
      },
    ) as unknown as OsyncCommandController;

    registerOsyncCommands(plugin, controller);

    const command = commands.find((entry) => entry.id === "open-sync-status");
    expect(command?.name).toBe("Open sync status");
    command?.callback?.();
    expect(opened).toBe(1);
  });
});
