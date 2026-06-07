import type { App } from "obsidian";

export class OsyncFileExplorerMarker {
  private oversizedPaths = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly app: App,
    private readonly getMaxFileSizeBytes: () => number,
  ) {}

  refresh(): void {
    const maxBytes = this.getMaxFileSizeBytes();
    if (maxBytes === 0) {
      this.unload();
      return;
    }

    this.oversizedPaths = new Set(
      this.app.vault
        .getFiles()
        .filter((f) => f.stat.size > maxBytes)
        .map((f) => f.path),
    );

    this.updateDom();
  }

  notifyFileChanged(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.refresh();
    }, 500);
  }

  unload(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.oversizedPaths.clear();
    activeDocument
      .querySelectorAll(".nav-file-title.osync-oversized")
      .forEach((el) => el.classList.remove("osync-oversized"));
  }

  private updateDom(): void {
    activeDocument
      .querySelectorAll<HTMLElement>(".nav-file-title[data-path]")
      .forEach((el) => {
        const path = el.getAttribute("data-path");
        if (path !== null) {
          el.classList.toggle("osync-oversized", this.oversizedPaths.has(path));
        }
      });
  }
}
