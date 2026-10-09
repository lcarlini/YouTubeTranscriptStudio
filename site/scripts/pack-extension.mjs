import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(siteRoot, "../extension");
const stage = join(tmpdir(), "yts-extension-pack");
const zipPath = join(siteRoot, "public", "extension.zip");

await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "icons"), { recursive: true });
await cp(join(extensionRoot, "manifest.json"), join(stage, "manifest.json"));
await cp(join(extensionRoot, "icons"), join(stage, "icons"), { recursive: true });
await cp(join(extensionRoot, "dist"), join(stage, "dist"), { recursive: true });
await rm(zipPath, { force: true });

const packed = spawnSync("tar", ["-a", "-cf", zipPath, "-C", stage, "."], { stdio: "inherit" });
if (packed.status !== 0) {
  throw new Error("Could not pack the extension zip.");
}
