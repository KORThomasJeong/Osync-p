import { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetObsidianMocks } from "../test-stubs/obsidian";
import {
  VerifyVaultKeyModal,
  type VaultKeyVerificationSource,
} from "./verify-vault-key-modal";

class FakeEl {
  text = "";
  value = "";
  disabled = false;
  children: FakeEl[] = [];
  classes = new Set<string>();
  attrs = new Map<string, string>();
  private listeners = new Map<string, Array<() => void>>();

  constructor(public tag = "div") {}

  createEl(tag: string, options: { text?: string; cls?: string } = {}): FakeEl {
    const child = new FakeEl(tag);
    if (options.text) child.text = options.text;
    for (const cls of options.cls?.split(/\s+/).filter(Boolean) ?? []) child.classes.add(cls);
    this.children.push(child);
    return child;
  }

  createDiv(options: { text?: string; cls?: string } = {}): FakeEl {
    return this.createEl("div", options);
  }

  createSpan(options: { text?: string; cls?: string } = {}): FakeEl {
    return this.createEl("span", options);
  }

  empty(): void {
    this.children = [];
    this.text = "";
  }

  setText(value: string): void {
    this.text = value;
  }

  addClass(cls: string): void {
    this.classes.add(cls);
  }

  setAttr(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  click(): void {
    if (this.disabled) return;
    this.fire("click");
  }

  all(): FakeEl[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }

  allText(): string {
    return this.all()
      .map((el) => el.text)
      .filter(Boolean)
      .join("\n");
  }

  button(text: string): FakeEl | undefined {
    return this.all().find((el) => el.tag === "button" && el.text === text);
  }

  find(cls: string): FakeEl | undefined {
    return this.all().find((el) => el.classes.has(cls));
  }
}

const UNREADABLE = [
  { entryId: "bad-1", revision: 3, entryType: "file" as const },
  { entryId: "bad-2", revision: 1, entryType: "file" as const },
];

function createSource(
  overrides: Partial<VaultKeyVerificationSource> = {},
): VaultKeyVerificationSource & {
  scan: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  reenter: ReturnType<typeof vi.fn>;
} {
  const scan = vi.fn(async (onProgress: (scanned: number, total: number) => void) => {
    onProgress(10, 10);
    return { scannedEntries: 10, unreadable: UNREADABLE, knownLocally: [] as string[] };
  });
  const remove = vi.fn(async () => ({ removed: ["bad-1", "bad-2"], failed: [] }));
  const reenter = vi.fn();
  return {
    getVaultName: () => "My Vault",
    getKeyFingerprints: async () => ({ local: "AAAAAAAAxyz", server: "AAAAAAAAxyz" }),
    scanUnreadableEntries: scan,
    removeUnreadableEntries: remove,
    reuploadLocalCopies: async () => 0,
    reenterVaultPassword: reenter,
    ...overrides,
    scan,
    remove,
    reenter,
  };
}

function openModal(source: VaultKeyVerificationSource) {
  const modal = new VerifyVaultKeyModal(new App() as never, source);
  const root = new FakeEl();
  (modal as unknown as { contentEl: FakeEl }).contentEl = root;
  modal.open();
  return { modal, root };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("VerifyVaultKeyModal", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("shows a match, scans, and only removes after the vault name is typed", async () => {
    const source = createSource();
    const { root } = openModal(source);
    await flush();

    expect(root.allText()).toContain("This device: AAAAAAAA   Server: AAAAAAAA");
    expect(root.allText()).toContain("✓ Match");
    expect(root.allText()).toContain("2 of 10 server entries can't be decrypted");
    expect(root.allText()).toContain("Local plaintext copies on the device that uploaded them are not affected");

    root.button("Remove unreadable entries from server")!.click();
    const confirm = root.button("Remove from server")!;
    const input = root.find("osync-verify-key-confirm-input")!;
    expect(confirm.disabled).toBe(true);

    input.value = "my vault";
    input.fire("input");
    confirm.click();
    expect(source.remove).not.toHaveBeenCalled();

    input.value = "My Vault";
    input.fire("input");
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await flush();

    expect(source.remove).toHaveBeenCalledWith(UNREADABLE);
    expect(root.allText()).toContain("Removed 2 entries from the server.");
  });

  it("on a mismatch offers password re-entry and never scans or offers removal", async () => {
    const source = createSource({
      getKeyFingerprints: async () => ({ local: "BBBBBBBBzzz", server: "AAAAAAAAxyz" }),
    });
    const { root } = openModal(source);
    await flush();

    expect(root.allText()).toContain("✗ Mismatch");
    expect(source.scan).not.toHaveBeenCalled();
    expect(root.button("Remove unreadable entries from server")).toBeUndefined();

    root.button("Re-enter vault password")!.click();
    expect(source.reenter).toHaveBeenCalledTimes(1);
  });

  it("scans but does not offer removal when the server has no recorded fingerprint", async () => {
    const source = createSource({
      getKeyFingerprints: async () => ({ local: "AAAAAAAAxyz", server: null }),
    });
    const { root } = openModal(source);
    await flush();

    expect(source.scan).toHaveBeenCalled();
    expect(root.allText()).toContain("can't be verified");
    expect(root.button("Remove unreadable entries from server")).toBeUndefined();
  });

  it("offers to re-upload local copies of unreadable entries this device still has", async () => {
    const reupload = vi.fn(async () => 1);
    const source = createSource({
      reuploadLocalCopies: reupload,
      scanUnreadableEntries: async () => ({
        scannedEntries: 3,
        unreadable: UNREADABLE,
        knownLocally: ["bad-1"],
      }),
    });
    const { root } = openModal(source);
    await flush();

    root.button("Re-upload 1 local copy")!.click();
    await flush();

    expect(reupload).toHaveBeenCalledWith(["bad-1"]);
  });
});
