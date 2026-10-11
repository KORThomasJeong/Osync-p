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
