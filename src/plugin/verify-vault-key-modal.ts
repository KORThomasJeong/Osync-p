import { type App, Modal, Notice } from "obsidian";

import type { UnreadableRemoteEntry } from "../sync/engine/unreadable-entries";

export interface VaultKeyFingerprints {
  // Fingerprint of the key this device encrypts with (null: no active session).
  local: string | null;
  // Fingerprint the server recorded for the vault (null: older vault, never recorded).
  server: string | null;
}

export interface VaultKeyVerificationSource {
  getVaultName(): string;
  getKeyFingerprints(): Promise<VaultKeyFingerprints>;
  scanUnreadableEntries(
    onProgress: (scanned: number, total: number) => void,
  ): Promise<{
    scannedEntries: number;
    unreadable: UnreadableRemoteEntry[];
    knownLocally: string[];
  }>;
  removeUnreadableEntries(
    targets: readonly UnreadableRemoteEntry[],
  ): Promise<{ removed: string[]; failed: Array<{ entryId: string; code: string }> }>;
  reuploadLocalCopies(entryIds: readonly string[]): Promise<number>;
  reenterVaultPassword(): void;
}

export type KeyMatch = "match" | "mismatch" | "unverifiable";

export function compareFingerprints(fingerprints: VaultKeyFingerprints): KeyMatch {
  if (!fingerprints.local || !fingerprints.server) {
    return "unverifiable";
  }
  return fingerprints.local === fingerprints.server ? "match" : "mismatch";
}

export function shortFingerprint(fingerprint: string | null): string {
  return fingerprint ? fingerprint.slice(0, 8) : "—";
}

// "Verify vault key": compares this device's key with the vault's recorded fingerprint,
// counts server entries this key cannot decrypt (read-only metadata scan, no blob
// downloads) and — only when the key is verified — offers to remove them.
export class VerifyVaultKeyModal extends Modal {
  private isOpen = false;
  private keyMatch: KeyMatch | null = null;
  private fingerprintEl: HTMLElement | null = null;
  private scanEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  private busy = false;

  constructor(
    app: App,
    private readonly source: VaultKeyVerificationSource,
  ) {
    super(app);
  }

  onOpen(): void {
    this.isOpen = true;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("osync-verify-key-modal");
    contentEl.createEl("h2", { text: "Verify vault key" });
    this.fingerprintEl = contentEl.createDiv({ cls: "osync-verify-key-fingerprint" });
    this.scanEl = contentEl.createDiv({ cls: "osync-verify-key-scan" });
    this.actionsEl = contentEl.createDiv({ cls: "osync-verify-key-actions" });
    void this.run();
  }

  onClose(): void {
    this.isOpen = false;
    this.contentEl.empty();
  }

  // Resolves when the fingerprint check (and the scan, if it ran) finished.
  async run(): Promise<void> {
    this.fingerprintEl?.setText("Checking the vault key…");
    let fingerprints: VaultKeyFingerprints;
    try {
      fingerprints = await this.source.getKeyFingerprints();
    } catch (error) {
      this.fingerprintEl?.setText(`Could not check the vault key: ${describe(error)}`);
      return;
    }
    if (!this.isOpen) return;
    this.keyMatch = compareFingerprints(fingerprints);
    this.renderFingerprints(fingerprints);
    if (this.keyMatch === "mismatch" || !fingerprints.local) {
      return;
    }
    await this.scan();
  }

  private renderFingerprints(fingerprints: VaultKeyFingerprints): void {
    const el = this.fingerprintEl;
    if (!el) return;
    el.empty();
    el.createDiv({
      cls: "osync-verify-key-line",
      text: `This device: ${shortFingerprint(fingerprints.local)}   Server: ${shortFingerprint(fingerprints.server)}`,
    });
    if (this.keyMatch === "match") {
      el.createDiv({ cls: "osync-verify-key-result is-match", text: "✓ Match — this device uses the vault's key." });
      return;
    }
    if (this.keyMatch === "mismatch") {
      el.createDiv({
        cls: "osync-verify-key-result is-mismatch",
        text: "✗ Mismatch — this device holds a different key (possibly another vault's). It must not sync until the vault password is re-entered.",
      });
      const button = el.createEl("button", { cls: "mod-cta", text: "Re-enter vault password" });
      button.addEventListener("click", () => {
        this.close();
        this.source.reenterVaultPassword();
      });
      return;
    }
    el.createDiv({
      cls: "osync-verify-key-result",
      text: fingerprints.local
        ? "The server has no recorded key fingerprint for this vault (created by an older version), so the key can't be verified."
        : "No vault key is loaded on this device.",
    });
  }

  private async scan(): Promise<void> {
    const el = this.scanEl;
    if (!el) return;
    el.empty();
    const progressEl = el.createDiv({ cls: "osync-verify-key-progress", text: "Scanning server entries…" });
    let result: Awaited<ReturnType<VaultKeyVerificationSource["scanUnreadableEntries"]>>;
    try {
      result = await this.source.scanUnreadableEntries((scanned, total) => {
        progressEl.setText(`Scanning server entries… ${scanned} / ${total}`);
      });
    } catch (error) {
      progressEl.setText(`Scan failed: ${describe(error)}`);
      return;
    }
    if (!this.isOpen) return;
    const count = result.unreadable.length;
    progressEl.setText(
      count === 0
        ? `All ${result.scannedEntries} server entries can be decrypted on this device.`
        : `${count} of ${result.scannedEntries} server entries can't be decrypted with this vault's key.`,
    );
    this.renderActions(result);
  }

  private renderActions(result: {
    unreadable: UnreadableRemoteEntry[];
    knownLocally: string[];
  }): void {
    const el = this.actionsEl;
    if (!el) return;
    el.empty();
    if (result.unreadable.length === 0) {
      return;
    }
    el.createEl("p", {
      cls: "osync-modal-hint",
      text: "These entries were written with a different key, usually by a device that had another vault's key saved. Local plaintext copies on the device that uploaded them are not affected, and they will upload again once that device is reconnected with the correct key.",
    });

    if (result.knownLocally.length > 0 && this.keyMatch !== "mismatch") {
      const reupload = el.createEl("button", {
        cls: "osync-verify-key-reupload",
        text: `Re-upload ${result.knownLocally.length} local cop${result.knownLocally.length === 1 ? "y" : "ies"}`,
      });
      reupload.addEventListener("click", () => {
        void this.runBusy(reupload, async () => {
          const count = await this.source.reuploadLocalCopies(result.knownLocally);
          new Notice(`Osync: ${count} local file${count === 1 ? "" : "s"} will be uploaded again.`);
        });
      });
    }

    // Removing needs proof that this device's key IS the vault's key, otherwise it
    // could delete healthy entries that only look unreadable to a wrong key.
    if (this.keyMatch !== "match") {
      return;
    }
    const remove = el.createEl("button", {
      cls: "mod-warning osync-verify-key-remove",
      text: "Remove unreadable entries from server",
    });
    remove.addEventListener("click", () => {
      this.renderRemovalConfirmation(result.unreadable);
    });
  }

  private renderRemovalConfirmation(targets: UnreadableRemoteEntry[]): void {
    const el = this.actionsEl;
    if (!el) return;
    el.empty();
    const vaultName = this.source.getVaultName();
    el.createEl("p", {
      text: `This deletes ${targets.length} unreadable entr${targets.length === 1 ? "y" : "ies"} on the server for every device. Their last versions stay in version history for the retention period. No file on this device is deleted.`,
    });
    el.createEl("p", {
      cls: "osync-modal-hint",
      text: "Update Osync on every device first: versions before 2.5.1 may delete a local file whose entry is removed.",
    });
    el.createEl("p", { text: `Type the vault name "${vaultName}" to confirm.` });
    const input = el.createEl("input", { cls: "osync-verify-key-confirm-input" });
    input.setAttr("type", "text");
    input.setAttr("placeholder", vaultName);
    const confirm = el.createEl("button", {
      cls: "mod-warning osync-verify-key-confirm",
      text: "Remove from server",
    });
    confirm.disabled = true;
    input.addEventListener("input", () => {
      confirm.disabled = this.busy || input.value !== vaultName;
    });
    confirm.addEventListener("click", () => {
      if (input.value !== vaultName) return;
      void this.runBusy(confirm, async () => {
        const result = await this.source.removeUnreadableEntries(targets);
        const failed =
          result.failed.length > 0
            ? ` ${result.failed.length} changed since the scan and were skipped; scan again.`
            : "";
        el.empty();
        el.createEl("p", {
          cls: "osync-verify-key-removed",
          text: `Removed ${result.removed.length} entr${result.removed.length === 1 ? "y" : "ies"} from the server.${failed}`,
        });
      });
    });
    const cancel = el.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      void this.scan();
    });
  }

  private async runBusy(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    button.disabled = true;
    try {
      await work();
    } catch (error) {
      new Notice(`Osync: ${describe(error)}`);
      button.disabled = false;
    } finally {
      this.busy = false;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
