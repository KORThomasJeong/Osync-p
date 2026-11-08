import { describe, expect, it } from "vitest";
import type { Plugin } from "obsidian";

import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import { ObsidianSyncVaultAdapter } from "./obsidian-vault-adapter";

// The .obsidian config scan walks the folder tree through the adapter. A folder it
// cannot list, or a file it cannot stat, must neither abort the scan nor look deleted.
describe("ObsidianSyncVaultAdapter config scan", () => {
  function createPlugin(): Plugin {
    const tree: Record<string, { files: string[]; folders: string[] }> = {
      ".obsidian": {
        files: [".obsidian/app.json", ".obsidian/locked.json"],
        folders: [".obsidian/plugins"],
      },
    };
    return {
      app: {
        vault: {
          getFiles: () => [],
          adapter: {
            async list(dir: string) {
              const listed = tree[dir];
              if (!listed) {
                throw new Error(`EACCES: permission denied, scandir '${dir}'`);
              }
              return listed;
            },
            async stat(path: string) {
              if (path === ".obsidian/locked.json") {
                throw new Error("EBUSY: resource busy or locked");
              }
              return { mtime: 5, size: 2 };
            },
          },
        },
      },
    } as unknown as Plugin;
  }

  it("lists what it can and reports what it could not scan", async () => {
    const adapter = new ObsidianSyncVaultAdapter(createPlugin(), () => ({
      ...DEFAULT_SYNC_FILE_RULES,
      includeObsidianConfig: true,
    }));

    const files = await adapter.listFiles();

    expect(files.map((file) => file.path)).toEqual([".obsidian/app.json"]);
    expect(adapter.listUnscannedPaths()).toEqual([".obsidian/locked.json", ".obsidian/plugins"]);
  });
});

// A pulled folder delete must actually remove the folder from disk. adapter.remove()
// only deletes files, so a folder left behind was scanned again and pushed back as a
// brand-new folder entry. OS metadata files (.DS_Store) must not keep a folder alive.
describe("ObsidianSyncVaultAdapter removeEmptyFolder", () => {
  function createPlugin(paths: { files: string[]; folders: string[] }) {
    const files = new Set(paths.files);
    const folders = new Set(paths.folders);
    const children = (dir: string) => {
      const direct = (path: string) =>
        path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/");
      return {
        files: [...files].filter(direct),
        folders: [...folders].filter(direct),
      };
    };
    const plugin = {
      app: {
        vault: {
          adapter: {
            async exists(path: string) {
              return files.has(path) || folders.has(path);
            },
            async list(dir: string) {
              return children(dir);
            },
            async remove(path: string) {
              if (folders.has(path)) {
                throw new Error(`EISDIR: illegal operation on a directory, unlink '${path}'`);
              }
              files.delete(path);
            },
            async rmdir(path: string, recursive: boolean) {
              const listed = children(path);
              if (!recursive && listed.files.length + listed.folders.length > 0) {
                throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
              }
              folders.delete(path);
            },
          },
        },
      },
    } as unknown as Plugin;
    return { plugin, files, folders };
  }

  function createAdapter(plugin: Plugin) {
    return new ObsidianSyncVaultAdapter(plugin, () => DEFAULT_SYNC_FILE_RULES);
  }

  it("removes an empty folder", async () => {
    const { plugin, folders } = createPlugin({ files: [], folders: ["Old"] });

    await expect(createAdapter(plugin).removeEmptyFolder("Old")).resolves.toBe(true);
    expect(folders.has("Old")).toBe(false);
  });

  it("removes a folder holding only OS metadata files", async () => {
    const { plugin, files, folders } = createPlugin({
      files: ["Old/.DS_Store", "Old/Thumbs.db", "Old/desktop.ini"],
      folders: ["Old"],
    });

    await expect(createAdapter(plugin).removeEmptyFolder("Old")).resolves.toBe(true);
    expect(files.size).toBe(0);
    expect(folders.has("Old")).toBe(false);
  });

  it("keeps a folder that still holds a file or a subfolder", async () => {
    const { plugin, files, folders } = createPlugin({
      files: ["A/note.md", "A/.DS_Store"],
      folders: ["A", "B", "B/child"],
    });
    const adapter = createAdapter(plugin);

    await expect(adapter.removeEmptyFolder("A")).resolves.toBe(false);
    await expect(adapter.removeEmptyFolder("B")).resolves.toBe(false);
    expect(files.has("A/.DS_Store")).toBe(true);
    expect([...folders].sort()).toEqual(["A", "B", "B/child"]);
  });

  it("does nothing for a folder that is already gone", async () => {
    const { plugin } = createPlugin({ files: [], folders: [] });

    await expect(createAdapter(plugin).removeEmptyFolder("Missing")).resolves.toBe(false);
  });
});
