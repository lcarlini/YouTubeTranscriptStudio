import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(root, "..");

await build({
  entryPoints: [resolve(extensionRoot, "src/background.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: resolve(extensionRoot, "dist/background.js"),
});

await build({
  entryPoints: [resolve(extensionRoot, "src/content.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: resolve(extensionRoot, "dist/content.js"),
});
