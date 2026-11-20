/**
 * VS Code packed inside Friday's app (Arun, 2026-11-19: "just package it up within friday", after "make sure this is light and not
 * disk space usage heavy too like the entire app download should be small if possible").
 *
 * For each platform the app is built for, code-server (the pinned build, src/runner/vscode.ts) is downloaded once into a cache,
 * checked against its pinned sha256, unpacked and slimmed (SLIM_PATHS: Copilot, its SDK, Mermaid previews), and left in
 * build/code-server/<os>-<arch>, which electron-builder puts in the app as Resources/code-server (extraResources in
 * scripts/oss-export.mts). The runner uses it from there first (bundledDir), so Code opens VS Code with nothing to download.
 *
 *   tsx scripts/vscode-bundle.mts                 the platforms this computer builds: a Mac both chips, else its own
 *   FRIDAY_VSCODE_ARCH=arm64 tsx scripts/...      one chip only (npm run mine builds for this Mac's chip)
 *   FRIDAY_NO_VSCODE=1                            skip: an app without VS Code (Code offers the download instead)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PINNED_ASSETS, slimBuild, syncBuiltinExtension, VSCODE_VERSION } from "../src/runner/vscode.js";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "build", "code-server");
const cache = process.env.FRIDAY_VSCODE_CACHE || path.join(os.homedir(), ".cache", "friday", "code-server");

/** electron-builder's os and arch names, to code-server's release names. */
const PLATFORMS: Record<string, string> = { "mac-arm64": "macos-arm64", "mac-x64": "macos-amd64", "win-x64": "windows-amd64", "linux-x64": "linux-amd64", "linux-arm64": "linux-arm64" };

function targets(): string[] {
  const only = process.env.FRIDAY_VSCODE_ARCH;
  if (process.platform === "darwin") return only ? [`mac-${only}`] : ["mac-arm64", "mac-x64"];
  if (process.platform === "win32") return ["win-x64"];
  return [`linux-${only || (process.arch === "arm64" ? "arm64" : "x64")}`];
}

const sha256 = (file: string) =>
  new Promise<string>((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });

async function archive(plat: string): Promise<string> {
  const pin = PINNED_ASSETS[plat];
  if (!pin) throw new Error(`No pinned code-server build for ${plat}`);
  const name = `code-server-${VSCODE_VERSION}-${plat}.tar.gz`;
  const file = path.join(cache, name);
  await mkdir(cache, { recursive: true });
  if (existsSync(file) && (await sha256(file)) === pin.sha256) return file;
  const url = `https://github.com/coder/code-server/releases/download/v${VSCODE_VERSION}/${name}`;
  console.log(`Downloading ${name} (${Math.round(pin.size / 1048576)} MB)…`);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`${url} answered ${r.status}`);
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(r.body as never), createWriteStream(part));
  const got = await sha256(part);
  if (got !== pin.sha256) {
    await rm(part, { force: true });
    throw new Error(`${name} didn't match its pinned sha256 (got ${got}); nothing was unpacked.`);
  }
  await rename(part, file);
  return file;
}

async function bundle(target: string) {
  const plat = PLATFORMS[target];
  if (!plat) throw new Error(`No code-server build for ${target}`);
  const dest = path.join(out, target);
  const marker = path.join(dest, ".friday-bundle");
  const want = `${VSCODE_VERSION} slim:5`;
  if (existsSync(marker) && (await readFile(marker, "utf8")).trim() === want) return console.log(`code-server ${target}: ready`);
  const file = await archive(plat);
  const staging = `${dest}.unpack`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  execFileSync(process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar", ["-xzf", file, "-C", staging], { stdio: "inherit" });
  const inner = (await readdir(staging, { withFileTypes: true })).find((e) => e.isDirectory());
  if (!inner) throw new Error(`${file} didn't unpack to a folder`);
  const built = path.join(staging, inner.name);
  await slimBuild(built);
  // electron-builder never copies a top-level node_modules into extraResources, filter or not, and code-server's own modules
  // live there (@coder/logger…). Its code is in out/, and Node looks for modules up the folders from there, so out/node_modules
  // serves the same and survives packaging.
  if (existsSync(path.join(built, "node_modules"))) await rename(path.join(built, "node_modules"), path.join(built, "out", "node_modules"));
  const bin = path.join(built, "bin", process.platform === "win32" && target.startsWith("win") ? "code-server.cmd" : "code-server");
  if (target === `${process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux"}-${process.arch}`) {
    // A .cmd runs only through the shell on Windows: Node refuses to spawn it directly (EINVAL), which failed v0.4.0's Windows build.
    // As the runner starts it (src/runner/vscode.ts).
    if (bin.endsWith(".cmd")) execFileSync(`"${bin}"`, ["--version"], { stdio: "pipe", timeout: 60_000, shell: true });
    else execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 60_000 });
  }
  await writeFile(path.join(built, ".friday-bundle"), `${want}\n`);
  await rm(dest, { recursive: true, force: true });
  await rename(built, dest);
  await rm(staging, { recursive: true, force: true });
  console.log(`code-server ${target}: packed (${Math.round((await du(dest)) / 1048576)} MB)`);
}

async function du(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true } as { withFileTypes: true; recursive: true })) {
    if (e.isFile()) n += (await stat(path.join(e.parentPath ?? (e as { path: string }).path, e.name))).size;
  }
  return n;
}

if (process.env.FRIDAY_NO_VSCODE) {
  console.log("VS Code not packed (FRIDAY_NO_VSCODE).");
} else {
  // Only the platforms being built, so an old one doesn't ride along into an installer it doesn't belong in.
  const keep = new Set(targets());
  for (const e of await readdir(out).catch(() => [] as string[])) if (!keep.has(e)) await rm(path.join(out, e), { recursive: true, force: true });
  for (const t of keep) {
    await bundle(t);
    // Friday's extension built in (src/runner/vscode.ts builtinExtDir), copied fresh each build so the app carries the current one.
    await syncBuiltinExtension(path.join(out, t), path.join(root, "src", "vscode-ext", "friday"));
  }
}
