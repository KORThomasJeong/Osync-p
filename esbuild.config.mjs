import { config as loadEnv } from "dotenv";
import esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(repoRoot, ".env") });

const production = process.argv[2] === "production";
const pluginDir = process.env.OBSIDIAN_PLUGIN_DIR?.trim();
const injectedApiBaseUrl = process.env.API_BASE_URL?.trim() ?? "";

const emptyNodeBuiltinPlugin = {
  name: "empty-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:(fs|crypto)$/ }, (args) => ({
      path: args.path,
      namespace: "empty-node-builtin",
    }));

    build.onLoad({ filter: /.*/, namespace: "empty-node-builtin" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

const shared = {
  entryPoints: [path.join(repoRoot, "src/main.ts")],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"],
  define: {
    __OSYNC_API_BASE_URL__: JSON.stringify(injectedApiBaseUrl),
  },
  format: "cjs",
  platform: "browser",
  target: "es2020",
  outfile: path.join(repoRoot, "main.js"),
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  plugins: [emptyNodeBuiltinPlugin],
};

async function copyToVault() {
  if (!pluginDir) return;
  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(repoRoot, "main.js"), path.join(pluginDir, "main.js")),
    fs.copyFile(path.join(repoRoot, "manifest.json"), path.join(pluginDir, "manifest.json")),
    fs.copyFile(path.join(repoRoot, "styles.css"), path.join(pluginDir, "styles.css")),
  ]);
  console.log(`[osync] copied plugin bundle to ${pluginDir}`);
}

if (production) {
  await esbuild.build(shared);
  await copyToVault();
} else {
  const ctx = await esbuild.context(shared);
  await ctx.watch();
  await ctx.rebuild();
  await copyToVault();
  console.log("[osync] watching Obsidian plugin sources");
}
