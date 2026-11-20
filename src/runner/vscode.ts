/**
 * Real VS Code inside Friday's Code mode, kept off the app download: code-server (MIT, github.com/coder/code-server) is an
 * optional, on-demand download into ~/.friday/vscode/ (or $FRIDAY_HOME/vscode/). This module downloads and verifies it, starts
 * one copy for the whole computer, installs Friday's own extension (src/vscode-ext/friday) and default settings, and stops it
 * when Code mode is left (10 minutes without the page's status heartbeat), on vscode.stop, and when Friday quits.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { applySkin } from "./vscode-skin.js";
import { isOwnCheckout } from "./git.js";
import { VSCODE_MENU_COMMANDS } from "../vscode-menu.js";

export const VSCODE_VERSION = "4.145.2";
const IDLE_MS = Number(process.env.FRIDAY_VSCODE_IDLE_MS) || 10 * 60_000;
/** The unpacked build, in bytes: `du` of the real macOS arm64 build was 644 MB (2026-11-19); the node inside is most of the platform difference. */
export const UNPACKED_ESTIMATE = 660_000_000;

export interface VsStatus {
  supported: boolean;
  platform: string;
  version: string;
  downloadBytes: number | null;
  /** What the unpacked build takes on disk (measured once, then remembered). */
  installed: { version: string; dir: string; bytes: number; /** Shipped inside Friday's app: nothing to download, nothing to remove. */ bundled?: boolean } | null;
  /** What it will take once unpacked, measured on the real 4.145.2 macOS arm64 build (644 MB by du); a good guide for the others. */
  unpackedBytes: number;
  /** What the person's own extensions, settings and caches take (data/ and extensions/), counted only when status is asked {sizes:true}; the last count otherwise, null before one. */
  dataBytes: number | null;
  installing: { received: number; total: number; stage: "download" | "verify" | "unpack" } | null;
  error: string | null;
  /** ready: the Friday extension inside has started for this folder (VS Code is drawn and listening), so the page can lift its cover. */
  running: { url: string; root: string; ready: boolean } | null;
}

const home = () => process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday");
const base = () => path.join(home(), "vscode");
const buildDir = () => path.join(base(), `code-server-${VSCODE_VERSION}`);
const dataDir = () => path.join(base(), "data");
const extDir = () => path.join(base(), "extensions");
const bridgeDir = () => path.join(base(), "bridge");

/** A folder's name in the bridge (ready-<this>.json): slashes one way, no trailing one, lower case on Windows. The extension makes the same. */
export function rootKey(root: string): string {
  let r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:/.test(r) || root.startsWith("\\\\")) r = r.toLowerCase();
  return createHash("sha1").update(r).digest("hex").slice(0, 12);
}
async function isReady(root: string): Promise<boolean> {
  if (!token) return false;
  try {
    return (await readFile(path.join(bridgeDir(), `ready-${rootKey(root)}.json`), "utf8")).includes(token);
  } catch {
    return false;
  }
}

/** The release asset's platform name, or null where code-server ships no build. */
function assetPlatform(): string | null {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!arch) return null;
  if (process.platform === "darwin") return `macos-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  if (process.platform === "win32" && arch === "amd64") return "windows-amd64";
  return null;
}
const assetName = (plat: string) => `code-server-${VSCODE_VERSION}-${plat}.tar.gz`;
const binPath = (dir: string) => path.join(dir, "bin", process.platform === "win32" ? "code-server.cmd" : "code-server");

/**
 * What a build carries that Friday never uses, left out of what ships and of what is kept after a download (Arun, 2026-11-19:
 * "make sure this is light and not disk space usage heavy", then "just package it up within friday"): GitHub Copilot and its
 * SDK (277 MB; Friday's agent panel is the AI here, and chat.disableAIFeatures is on) and Mermaid's diagram previews (64 MB).
 * code-server 4.145.2 for Apple silicon goes from 629 MB to 288 MB unpacked, 82 MB compressed, and starts and opens a folder.
 */
export const SLIM_PATHS = ["lib/vscode/extensions/copilot", "lib/vscode/node_modules/@github", "lib/vscode/extensions/mermaid-markdown-features"];
export async function slimBuild(dir: string): Promise<void> {
  for (const p of SLIM_PATHS) await rm(path.join(dir, ...p.split("/")), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await hideAccountsByDefault(dir);
  await applySkin(dir);
}

/**
 * The Accounts button at the foot of the activity bar, hidden from the start (Arun, 2026-11-19: "get rid of this too"): Friday
 * signs nothing in through VS Code. It isn't a setting VS Code reads from settings.json but a stored preference that defaults to
 * shown, so the build's default is flipped. A build where the line isn't found is left as it is: the button shows, nothing breaks.
 */
async function hideAccountsByDefault(dir: string): Promise<void> {
  const file = path.join(dir, "lib", "vscode", "out", "vs", "code", "browser", "workbench", "workbench.js");
  const js = await readFile(file, "utf8").catch(() => null);
  if (js === null) return;
  const next = js.replace(/(getBoolean\(\w+\.ACCOUNTS_VISIBILITY_PREFERENCE_KEY,0,)!0\)/, "$1!1)");
  if (next !== js) await writeFile(file, next);
}

/**
 * The copy that ships inside Friday's app (scripts/vscode-bundle.mts, electron-builder's extraResources "code-server"), when this
 * is the app: used first, so Code opens VS Code with nothing to download. FRIDAY_VSCODE_BUNDLED points elsewhere for tests.
 */
export function bundledDir(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const dir = process.env.FRIDAY_VSCODE_BUNDLED || (resources ? path.join(resources, "code-server") : "");
  return dir && existsSync(binPath(dir)) ? dir : null;
}
/** The build Code runs: the app's own, else the one downloaded into ~/.friday/vscode. */
const activeDir = () => bundledDir() ?? buildDir();

/**
 * The reviewed release, pinned: the sha256 and size of each build of code-server 4.145.2 (from the GitHub release's own digests),
 * so what Friday runs is what was looked at when this version was chosen, with no lookup at install time and no API rate limit.
 * Moving VSCODE_VERSION means copying the new digests here (test/vscode-runner.test.ts checks every platform has an entry).
 */
export const PINNED_ASSETS: Record<string, { sha256: string; size: number }> = {
  "macos-arm64": { sha256: "d6699692f1e59d918517c81f9d2a4ef335132128cd45725b22236d5fe09636d4", size: 214949354 },
  "macos-amd64": { sha256: "5fb7ac2bd60538400244d942f649559e0ff4fb3d8792979287f504780f357af6", size: 233667873 },
  "linux-amd64": { sha256: "2f6db6c3e8b733dd6b3aeee83532e148b2bae2e392353ba85452d03572348962", size: 236495502 },
  "linux-arm64": { sha256: "e867a34416e2da4a83496b09580001893e7a4e5bb58a0624c4fcd22819e7d53d", size: 233639045 },
  "windows-amd64": { sha256: "d88f8a00831334da291ad29b35714c7bf6d3dc398e5b6f5ed1b20034c1da7675", size: 217402969 },
};

interface Asset {
  url: string;
  sha256: string;
  size: number;
}

/**
 * Where to get a platform's build and what it must hash to. Tests may point FRIDAY_VSCODE_DOWNLOAD_BASE at a local server; the
 * download is still checked against the pinned digest unless the test also gives FRIDAY_VSCODE_SHA256 (and FRIDAY_VSCODE_SIZE).
 */
export function assetFor(plat: string): Asset {
  const pin = PINNED_ASSETS[plat];
  if (!pin) throw new Error("Friday IDE has no download for this computer.");
  const override = process.env.FRIDAY_VSCODE_DOWNLOAD_BASE;
  if (!override) return { url: `https://github.com/coder/code-server/releases/download/v${VSCODE_VERSION}/${assetName(plat)}`, sha256: pin.sha256, size: pin.size };
  return {
    url: `${override.replace(/\/+$/, "")}/${assetName(plat)}`,
    sha256: (process.env.FRIDAY_VSCODE_SHA256 || pin.sha256).toLowerCase(),
    size: Number(process.env.FRIDAY_VSCODE_SIZE) || 0,
  };
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}

// ---------- state (one per process) ----------
let installing: VsStatus["installing"] = null;
let installError: string | null = null;
let installCtl: { abort: AbortController; reason: "" | "stall" | "cancel"; done: Promise<void> } | null = null;
let child: ChildProcess | null = null;
let childExit: Promise<void> = Promise.resolve();
let starting: Promise<{ url: string; port: number }> | null = null;
let running: { url: string; root: string; port: number } | null = null;
let token: string | null = null;
let key: string | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let hooked = false;
let inited: Promise<void> | null = null;
let sizeMemo: { dir: string; bytes: number } | null = null;

/** The token the running VS Code's extension sends with its asks (app.ts checks it), null when none is running. */
export function vscodeToken(): string | null {
  return token;
}

/** Only for tests of the routes the IDE's extension calls with its token: they have no IDE running to mint one. */
export function setVscodeTokenForTest(t: string | null): void {
  token = t;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const rmr = (p: string) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/** rename that outlasts a virus scanner still holding the freshly unpacked files (Windows: EPERM/EBUSY/EACCES). */
async function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 8 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      await sleep(250 * (i + 1));
    }
  }
}

function heartbeat() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = running || child ? setTimeout(() => void stopVscode(), IDLE_MS) : null;
  idleTimer?.unref();
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Signal a server and everything it started: the process group (it was spawned as a leader), taskkill /t on Windows. */
async function killTree(pid: number, force: boolean) {
  if (process.platform === "win32") {
    await new Promise<void>((res) => execFile("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => res()));
    return;
  }
  const sig = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone.
    }
  }
}

/** Synchronous version for process 'exit', where nothing async finishes. */
function killChildNow() {
  const c = child;
  if (!c?.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/t", "/f"], { windowsHide: true, timeout: 3000 });
    else {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {
        c.kill("SIGTERM");
      }
    }
    rmSync(recordFile(), { force: true });
  } catch {
    // Already gone.
  }
}

/** SIGTERM, then SIGKILL if it has not gone within five seconds; resolves once the child has exited. */
async function killChild() {
  const c = child;
  if (!c) return;
  if (c.pid) {
    await killTree(c.pid, false);
    const gone = await Promise.race([childExit.then(() => true), sleep(5000).then(() => false)]);
    if (!gone) {
      await killTree(c.pid, true);
      await Promise.race([childExit, sleep(2000)]);
    }
  }
}

function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on("exit", killChildNow);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      killChildNow();
      // Chain: when no later listener (the server's or the shell's own graceful shutdown) is there, end the process as the default would.
      if (process.listenerCount(sig) === 1) process.exit(0);
    });
  }
}

// ---------- the record of the running server, for finding one a crash left behind ----------
const recordFile = () => path.join(base(), "server.json");
const lockFile = () => path.join(base(), "install.lock");
interface Record_ {
  pid: number;
  port: number;
  owner: number;
  startedAt: number;
}

async function readRecord(): Promise<Record_ | null> {
  try {
    const r = JSON.parse(await readFile(recordFile(), "utf8")) as Partial<Record_>;
    return typeof r.pid === "number" && typeof r.port === "number" ? { pid: r.pid, port: r.port, owner: Number(r.owner) || 0, startedAt: Number(r.startedAt) || 0 } : null;
  } catch {
    return null;
  }
}

/** Is a code-server answering on this port? Its health answer is JSON with a status, not just any 200. */
async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = (await r.json()) as { status?: unknown };
    return typeof j.status === "string";
  } catch {
    return false;
  }
}

/**
 * Stop the server the record names, if it is still ours to find: its process is alive and that port still answers like a
 * code-server (so a recycled pid is never hit). Used for orphans (a force-quit left it) and before every start.
 */
async function killRecorded() {
  const rec = await readRecord();
  if (!rec) return;
  if (pidAlive(rec.pid) && (await healthy(rec.port))) {
    await killTree(rec.pid, false);
    for (let i = 0; i < 20 && pidAlive(rec.pid); i++) await sleep(150);
    if (pidAlive(rec.pid)) await killTree(rec.pid, true);
  }
  await rm(recordFile(), { force: true }).catch(() => {});
}

async function lockHolder(): Promise<number | null> {
  try {
    const pid = Number((await readFile(lockFile(), "utf8")).trim());
    return pid && pid !== process.pid && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Anything an interrupted or abandoned install left: partial downloads, staging folders, builds of older versions. */
async function sweep() {
  const holder = await lockHolder();
  for (const e of await readdir(base()).catch(() => [] as string[])) {
    const stale = e.endsWith(".part") || /^u\d+$/.test(e) || e.startsWith("unpack-");
    const oldBuild = e.startsWith("code-server-") && !e.endsWith(".part") && e !== path.basename(buildDir());
    if ((stale && !holder) || oldBuild) await rmr(path.join(base(), e)).catch(() => {});
  }
}

/** Once per process, the first time VS Code is touched: end an orphan a dead Friday left, and clear leftovers. */
function init(): Promise<void> {
  inited ??= (async () => {
    const rec = await readRecord();
    if (rec && !child && !(rec.owner && pidAlive(rec.owner) && rec.owner !== process.pid)) await killRecorded();
    if (existsSync(base())) await sweep();
  })().catch(() => {});
  return inited;
}

let dataMemo: number | null = null;

export async function vscodeStatus(opts: { sizes?: boolean; root?: string } = {}): Promise<VsStatus> {
  await init();
  if (opts.sizes) dataMemo = (await dirBytes(dataDir())) + (await dirBytes(extDir()));
  const plat = assetPlatform();
  const dir = activeDir();
  const stand = process.env.FRIDAY_CODE_SERVER_BIN;
  let inst: VsStatus["installed"] = null;
  if (stand && existsSync(stand)) inst = { version: VSCODE_VERSION, dir: path.dirname(stand), bytes: 0 };
  else if (existsSync(binPath(dir))) {
    // The size never changes after install: measured once, not on every heartbeat.
    if (sizeMemo?.dir !== dir) sizeMemo = { dir, bytes: await dirBytes(dir) };
    inst = { version: VSCODE_VERSION, dir, bytes: sizeMemo.bytes, ...(dir === bundledDir() ? { bundled: true } : {}) };
  }
  if (running || child) heartbeat();
  let downloadBytes: number | null = null;
  try {
    downloadBytes = plat ? assetFor(plat).size || PINNED_ASSETS[plat]?.size || null : null;
  } catch {
    // No download for this computer.
  }
  return {
    supported: !!plat || !!stand,
    platform: plat ?? `${process.platform}-${process.arch}`,
    version: VSCODE_VERSION,
    downloadBytes,
    installed: inst,
    unpackedBytes: UNPACKED_ESTIMATE,
    dataBytes: dataMemo,
    installing,
    error: installError,
    running: running ? { url: running.url, root: running.root, ready: await isReady(opts.root || running.root) } : null,
  };
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve()));
  });
}

/** The system's own tar: on Windows System32's bsdtar by full path (a Git for Windows tar earlier on PATH reads "C:" as a host). */
const tarBin = () => (process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar");

const MIN_FREE = 1.2 * 1024 ** 3;
const STALL_MS = Number(process.env.FRIDAY_VSCODE_STALL_MS) || 60_000;

function friendlyDiskError(e: unknown): unknown {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return new Error("Not enough room on this disk: Friday IDE needs about 1 GB free.");
  return e;
}

async function doInstall(plat: string, ctl: NonNullable<typeof installCtl>) {
  const root = base();
  await mkdir(root, { recursive: true });
  // One install at a time on this computer, whichever Friday asks: an exclusive lock file holding the installer's pid.
  const holder = await lockHolder();
  if (holder) throw new Error("Another Friday on this computer is installing Friday IDE. Try again in a minute.");
  await rm(lockFile(), { force: true });
  const lock = await open(lockFile(), "wx").catch(() => null);
  if (!lock) throw new Error("Another Friday on this computer is installing Friday IDE. Try again in a minute.");
  await lock.writeFile(String(process.pid));
  await lock.close();
  const archive = path.join(root, `${assetName(plat)}.${process.pid}.part`);
  const staging = path.join(root, `u${process.pid}`);
  let stall: NodeJS.Timeout | null = null;
  const bump = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => {
      ctl.reason ||= "stall";
      ctl.abort.abort();
    }, STALL_MS);
  };
  try {
    await sweep();
    const asset = assetFor(plat);
    installing = { received: 0, total: asset.size, stage: "download" };
    try {
      const fs = await statfs(root);
      if (asset.size && fs.bavail * fs.bsize < Math.max(MIN_FREE, asset.size * 2)) throw new Error("Not enough room on this disk: Friday IDE needs about 1 GB free.");
    } catch (e) {
      if (e instanceof Error && /Not enough room/.test(e.message)) throw e;
    }
    bump();
    const r = await fetch(asset.url, { headers: { "user-agent": "friday" }, signal: ctl.abort.signal });
    if (!r.ok || !r.body) throw new Error(`The download failed (${r.status}).`);
    const total = Number(r.headers.get("content-length")) || asset.size;
    installing = { received: 0, total, stage: "download" };
    const hash = createHash("sha256");
    let received = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        received += chunk.byteLength;
        installing = { received, total, stage: "download" };
        bump();
        cb(null, chunk);
      },
    });
    // pipeline ends on any write error (a full disk) and cleans both ends up, so nothing waits on a stream that is gone.
    await pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), tap, createWriteStream(archive), { signal: ctl.abort.signal });
    if (stall) clearTimeout(stall);
    installing = { received, total: received, stage: "verify" };
    if (hash.digest("hex") !== asset.sha256) throw new Error("The download didn't match its checksum, so it was thrown away. Try again.");
    installing = { received, total: received, stage: "unpack" };
    await rmr(staging);
    await mkdir(staging, { recursive: true });
    await run(tarBin(), ["-xzf", archive, "-C", staging]);
    if (ctl.reason === "cancel") throw new Error("cancelled");
    const inner = (await readdir(staging, { withFileTypes: true })).find((e) => e.isDirectory());
    if (!inner || !existsSync(binPath(path.join(staging, inner.name)))) throw new Error("The download didn't unpack to a Friday IDE build.");
    await slimBuild(path.join(staging, inner.name));
    await rmr(buildDir());
    await renameRetry(path.join(staging, inner.name), buildDir());
    sizeMemo = null;
  } catch (e) {
    if (ctl.reason === "stall") throw new Error("The download stalled. Try again.");
    if (ctl.reason === "cancel") throw new Error("cancelled");
    const code = (e as { code?: string; cause?: { code?: string } } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code ?? "";
    // A dropped or missing connection, in a sentence (the raw "fetch failed" says nothing to a person).
    if (e instanceof TypeError || /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR/.test(code) || /fetch failed|terminated/i.test(e instanceof Error ? e.message : "")) throw new Error("No connection. Nothing was kept; try again when you're online.");
    throw friendlyDiskError(e);
  } finally {
    if (stall) clearTimeout(stall);
    await rm(archive, { force: true }).catch(() => {});
    await rmr(staging).catch(() => {});
    await rm(lockFile(), { force: true }).catch(() => {});
  }
}

export async function vscodeInstall(): Promise<VsStatus> {
  const plat = assetPlatform();
  if (!plat) throw new Error("Friday IDE isn't available for this computer.");
  const s = await vscodeStatus();
  if (s.installed || installing) return s;
  installError = null;
  installing = { received: 0, total: s.downloadBytes ?? 0, stage: "download" };
  const ctl: NonNullable<typeof installCtl> = { abort: new AbortController(), reason: "", done: Promise.resolve() };
  installCtl = ctl;
  ctl.done = doInstall(plat, ctl)
    .catch((e) => {
      if (ctl.reason !== "cancel") installError = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      if (installCtl === ctl) {
        installCtl = null;
        installing = null;
      }
    });
  return vscodeStatus();
}

/** Stop a download under way (the card's cancel): the partial file goes, nothing is reported as an error. */
export async function vscodeCancel(): Promise<VsStatus> {
  if (installCtl) {
    installCtl.reason = "cancel";
    installCtl.abort.abort();
    await installCtl.done.catch(() => {});
  }
  return vscodeStatus();
}

/** Friday's extension folder: beside the source in development, beside the bundle in the app, FRIDAY_VSCODE_EXT to point elsewhere. */
export function extensionSource(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tries = [
    process.env.FRIDAY_VSCODE_EXT,
    path.join(here, "..", "vscode-ext", "friday"),
    path.join(here, "vscode-ext", "friday"),
    path.join(here, "..", "src", "vscode-ext", "friday"),
    path.join(process.cwd(), "src", "vscode-ext", "friday"),
  ];
  for (const t of tries) if (t && existsSync(path.join(t, "package.json"))) return t;
  return null;
}

/**
 * Friday's extension as one of VS Code's built-in ones (Arun, 2026-11-19: "dont have this be there", of Friday in the Installed
 * list): in the build's own extensions folder it runs the same, and isn't listed as something the person installed. The copy in
 * the app has it from packing (scripts/vscode-bundle.mts); a downloaded copy gets it here, kept up to date with Friday's.
 */
export const builtinExtDir = (dir: string) => path.join(dir, "lib", "vscode", "extensions", "friday");

/** Whether two folders hold the same files, byte for byte. */
async function sameFolder(a: string, b: string): Promise<boolean> {
  try {
    const sig = async (d: string) => {
      const names = (await readdir(d, { recursive: true } as { recursive: true })).map(String).sort();
      const parts: string[] = [];
      for (const n of names) {
        const s = await stat(path.join(d, n));
        if (s.isFile()) parts.push(`${n}:${s.size}:${createHash("sha1").update(await readFile(path.join(d, n))).digest("hex")}`);
      }
      return parts.join("|");
    };
    return (await sig(a)) === (await sig(b));
  } catch {
    return false;
  }
}

/** Friday's extension into a build's built-in folder, when it differs. Returns false when there is no source to copy. */
export async function syncBuiltinExtension(dir: string, src: string | null = extensionSource()): Promise<boolean> {
  if (!src) return false;
  const dest = builtinExtDir(dir);
  if (existsSync(dest) && (await sameFolder(src, dest))) return true;
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
  return true;
}

/** Where Friday's extension runs from: built in when the build has it (or can be given it), else installed as a user extension. */
async function placeExtension(): Promise<void> {
  const dir = activeDir();
  const bundled = bundledDir() === dir;
  // The app's own copy is read-only (and signed): it has the extension from packing, or it doesn't.
  const builtin = bundled ? existsSync(path.join(builtinExtDir(dir), "package.json")) : await syncBuiltinExtension(dir).catch(() => false);
  if (!builtin) return installExtension();
  // The installed copy an older Friday put there goes, or it would load twice.
  for (const e of await readdir(extDir()).catch(() => [] as string[])) {
    if (e.startsWith("friday.friday-")) await rm(path.join(extDir(), e), { recursive: true, force: true });
  }
}

async function installExtension() {
  const src = extensionSource();
  if (!src) return;
  const pkg = JSON.parse(await readFile(path.join(src, "package.json"), "utf8")) as { version?: string; publisher?: string; name?: string };
  const id = `${pkg.publisher || "friday"}.${pkg.name || "friday"}-${pkg.version || "0.0.0"}`;
  const dest = path.join(extDir(), id);
  await mkdir(extDir(), { recursive: true });
  // Older copies of ours go; a changed folder under the same version is copied over.
  for (const e of await readdir(extDir()).catch(() => [] as string[])) {
    if (e.startsWith(`${pkg.publisher || "friday"}.${pkg.name || "friday"}-`) && e !== id) await rm(path.join(extDir(), e), { recursive: true, force: true });
  }
  if (existsSync(dest) && (await sameFolder(src, dest))) return;
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  "window.autoDetectColorScheme": true,
  "workbench.preferredDarkColorTheme": "Friday Dark",
  "workbench.preferredLightColorTheme": "Friday Light",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "workbench.startupEditor": "none",
  "security.workspace.trust.enabled": false,
  // With trust off, a folder's `.vscode/tasks.json` task marked to run when the folder opens would run unasked. Off is the IDE's
  // own default; it is written so it is plain (a pull request's copy is a stranger's folder, pr-ide.ts), and it is an
  // application-wide setting that no folder's own settings can turn on.
  "task.allowAutomaticTasks": "off",
  "chat.disableAIFeatures": true,
  // The same stack as Friday's own code font (--mono), so both halves of the window agree: a web page cannot name Geist Mono or
  // SF Mono unless installed, and Friday's webfont does not cross into this origin.
  "editor.fontFamily": "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  "terminal.integrated.fontFamily": "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  "editor.fontSize": 13,
  "window.commandCenter": false,
  // Inside Friday's window, VS Code's own chrome that only repeats Friday's (checked against code-server 4.145.2): no title strip
  // ("index.ts — scratch — code-server"; the menu stays in the activity bar), no empty right-hand bar where its AI chat would be
  // (Friday's agent sits there), no accounts button, no layout buttons.
  "window.titleBarStyle": "native",
  "window.title": "\${activeEditorShort}\${separator}\${rootName}",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.activity.showAccounts": false,
  "workbench.layoutControl.enabled": false,
  "chat.commandCenter.enabled": false,
  // One flush surface, not VS Code 1.145's floating cards with gaps between them (Arun, 2026-11-19: "all of this needs to be flush
  // with everything and not like gaps between each other"): its "modern UI" is on by default there.
  "workbench.experimental.modernUI": false,
  // No menu button (Friday's own menus and ⌘⇧P cover it) (Arun, 2026-11-19: "get rid of this too"). The activity bar's size and
  // look are Friday's skin's (vscode-skin.ts), on the full-width bar.
  "window.menuBarVisibility": "hidden",
  // A touch taller row for the editor's inline actions, so a merge conflict's banner (vscode-skin.ts) has room.
  "editor.codeLensFontSize": 13,
};

/**
 * Defaults Friday wrote once and has taken back: a key still holding exactly that value goes, so VS Code's own default applies again.
 * The compact activity bar made its icons too small (Arun, 2026-11-19: "making these bigger"); the skin sizes them now.
 */
const RETIRED_SETTINGS: Record<string, unknown> = {
  "workbench.activityBar.compact": true,
};

async function writeDefaultSettings() {
  const file = path.join(dataDir(), "User", "settings.json");
  await mkdir(path.dirname(file), { recursive: true });
  let cur: Record<string, unknown> = {};
  let exists = false;
  try {
    const text = await readFile(file, "utf8");
    exists = true;
    // Only strict JSON is rewritten. A settings.json with comments or trailing commas is the person's own hand-kept file: left alone.
    const parsed = JSON.parse(text.trim() || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    cur = parsed as Record<string, unknown>;
  } catch {
    if (exists) return;
  }
  let changed = !exists;
  for (const [k, v] of Object.entries(RETIRED_SETTINGS)) {
    if (k in cur && cur[k] === v) {
      delete cur[k];
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in cur)) {
      cur[k] = v;
      changed = true;
    }
  }
  if (changed) await writeFile(file, JSON.stringify(cur, null, 2) + "\n");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * The same port launch after launch, when it is free (Arun, 2026-11-19, wave 4: "quit Friday mid-work and come back exactly where you
 * were"). The IDE keeps each folder's open editors, layout and scroll positions in the page's own storage, and a page's storage
 * belongs to its origin, port included: a new random port every launch started every folder from nothing. The last port used is
 * kept in the IDE's folder; if something else holds it now, a free one is taken and kept instead. Friday builds on one home (the
 * production app and a test one both use ~/.friday) share that file; one IDE per computer is already the rule (killRecorded), so
 * the one launched last takes the port.
 */
export async function stablePort(file: string = path.join(base(), "port"), free: (port: number) => Promise<boolean> = portFree, fresh: () => Promise<number> = freePort): Promise<number> {
  let last = 0;
  try {
    last = Number((await readFile(file, "utf8")).trim());
  } catch {
    // Never launched here: a new one.
  }
  const port = Number.isInteger(last) && last > 1024 && last < 65536 && (await free(last)) ? last : await fresh();
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  await writeFile(file, String(port)).catch(() => {});
  return port;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/**
 * VS Code's web workbench takes ?folder= as a path on the server only when it starts with "/"; anything else is parsed as a URI,
 * where "C:\Users\me" is scheme "c". So on Windows a drive path becomes /C:/Users/me and a UNC path //server/share/x.
 */
export function folderParam(root: string, platform: string = process.platform): string {
  if (platform !== "win32") return root;
  const s = root.replace(/\\/g, "/");
  return s.startsWith("/") ? s : `/${s}`;
}
export const urlFor = (port: number, root: string, platform: string = process.platform) => (root ? `http://127.0.0.1:${port}/?folder=${encodeURIComponent(folderParam(root, platform))}` : `http://127.0.0.1:${port}/`);
/** code-server's sign-in, which sends the browser on to the folder once the password is right. */
export const loginFor = (port: number, root: string, platform: string = process.platform) =>
  `http://127.0.0.1:${port}/login?to=${encodeURIComponent(root ? `/?folder=${encodeURIComponent(folderParam(root, platform))}` : "/")}`;

async function attempt(bin: string, port: number, withIdle: boolean, serverUrl: string): Promise<void> {
  const args = [
    "--bind-addr", `127.0.0.1:${port}`,
    // Not "none": anything that reaches the port (a rebound web page, a hidden frame on another site, another user of this
    // computer) would otherwise get an editor with a terminal. The session cookie is host-scoped and SameSite=Lax.
    "--auth", "password",
    "--disable-telemetry",
    "--disable-update-check",
    "--disable-workspace-trust",
    "--disable-getting-started-override",
    "--user-data-dir", dataDir(),
    "--extensions-dir", extDir(),
    "--ignore-last-opened",
    // Its own name inside it, the title and About (Arun, 2026-11-19: "name it Friday IDE do not mention Vscode").
    "--app-name", "Friday IDE",
    // The server's own dead-man switch: one with no page connected for an hour ends itself, even with no Friday left to say so.
    ...(withIdle ? ["--idle-timeout-seconds", "3600"] : []),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, PASSWORD: key!, FRIDAY_VSCODE_BRIDGE: bridgeDir(), FRIDAY_URL: serverUrl, FRIDAY_VSCODE_TOKEN: token!, PORT: String(port) };
  delete env.HASHED_PASSWORD;
  delete env.EXTENSIONS_GALLERY;
  const market = await readMarketplace();
  if (market) env.EXTENSIONS_GALLERY = JSON.stringify(market);
  // A stand-in may be a .js/.mjs/.cjs script: run it with this node.
  const asNode = /\.(c|m)?js$/i.test(bin);
  const c = asNode
    ? spawn(process.execPath, [bin, ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" })
    : process.platform === "win32"
      ? spawn(`"${bin}"`, args.map((a) => `"${a}"`), { env, stdio: "ignore", windowsHide: true, shell: true })
      : spawn(bin, args, { env, stdio: "ignore", detached: true });
  child = c;
  c.unref();
  let exited = false;
  childExit = new Promise<void>((res) => {
    c.on("exit", () => {
      exited = true;
      if (child === c) {
        child = null;
        running = null;
        token = null;
        key = null;
        if (idleTimer) clearTimeout(idleTimer);
        void rm(recordFile(), { force: true }).catch(() => {});
      }
      res();
    });
    c.on("error", () => {
      exited = true;
      res();
    });
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) break;
    // Answered like a code-server by this very child, not by whatever took the port in the gap after it was picked.
    if (await healthy(port)) {
      if (!exited && c.pid) {
        const rec: Record_ = { pid: c.pid, port, owner: process.pid, startedAt: Date.now() };
        await writeFile(recordFile(), JSON.stringify(rec)).catch(() => {});
        return;
      }
      break;
    }
    await sleep(250);
  }
  if (!exited) {
    await killChild();
    child = null;
    throw new Error("Friday IDE didn't start in time.");
  }
  child = null;
  throw Object.assign(new Error("Friday IDE stopped as it started."), { exited: true });
}

async function launch(serverUrl: string): Promise<{ url: string; port: number }> {
  const stand = process.env.FRIDAY_CODE_SERVER_BIN;
  const bin = stand || binPath(activeDir());
  if (!existsSync(bin)) throw new Error("Friday IDE isn't installed yet.");
  await init();
  await mkdir(bridgeDir(), { recursive: true });
  await mkdir(dataDir(), { recursive: true });
  // One VS Code per computer: one an earlier run (or another Friday) left on the same folders goes first.
  await killRecorded();
  await placeExtension().catch(() => {});
  await writeDefaultSettings().catch(() => {});
  token = randomBytes(24).toString("hex");
  key = randomBytes(24).toString("hex");
  hookExit();
  let port = 0;
  try {
    try {
      port = await stablePort();
      await attempt(bin, port, true, serverUrl);
    } catch (e) {
      // A code-server without the idle flag stops at once on it: once more without.
      if (!(e as { exited?: boolean }).exited) throw e;
      // The same kept port (the failed child has exited and let it go), or the IDE's editors and layout are lost on this path too.
      port = await stablePort();
      await attempt(bin, port, false, serverUrl);
    }
  } catch (e) {
    token = null;
    key = null;
    throw e;
  }
  return { url: `http://127.0.0.1:${port}`, port };
}

/** Start (or reuse) VS Code on a folder, or on none: "" is VS Code's own empty window. */
export async function vscodeStart(root: string, serverUrl: string): Promise<{ url: string; login: string; key: string }> {
  if (!running) {
    starting ??= launch(serverUrl).finally(() => {
      starting = null;
    });
    const r = await starting;
    running = { url: "", root, port: r.port };
  }
  running.root = root;
  running.url = urlFor(running.port, root);
  heartbeat();
  // The key is what signs the frame in (a one-off form post to `login`); it never appears in an address.
  return { url: running.url, login: loginFor(running.port, root), key: key ?? "" };
}

export async function stopVscode(): Promise<{ ok: true }> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const pending = starting;
  running = null;
  await killChild();
  // A start still waiting on its health check has a child of its own now: it fails and is cleaned up by its own attempt.
  if (pending) await pending.catch(() => {});
  if (child) await killChild();
  child = null;
  token = null;
  key = null;
  await killRecorded().catch(() => {});
  return { ok: true };
}

export async function vscodeRemove(all = false): Promise<VsStatus> {
  // A download under way is cancelled and awaited first, so it cannot put the build back or delete a newer one's files.
  await vscodeCancel();
  await stopVscode();
  installing = null;
  installError = null;
  sizeMemo = null;
  for (const e of await readdir(base()).catch(() => [] as string[])) {
    if (e.startsWith("code-server-") || e.endsWith(".part") || /^u\d+$/.test(e) || e.startsWith("unpack-")) await rmr(path.join(base(), e));
  }
  if (all) await rmr(base());
  else {
    // What is only a cache goes with it (made again on the next start); settings, extensions and history stay.
    for (const d of ["logs", "CachedExtensionVSIXs", "CachedData", "CachedProfilesData", "Crashpad", "Cache", "Code Cache"]) await rmr(path.join(dataDir(), d));
    await rmr(bridgeDir());
  }
  dataMemo = null;
  return vscodeStatus({ sizes: true });
}

/** Ask the running VS Code to open a file: a request the Friday extension watches for. */
export async function vscodeOpen(file: string, line?: number, root?: string, end?: number, side?: boolean): Promise<{ ok: true }> {
  if (!running) throw new Error("Friday IDE isn't running.");
  await mkdir(bridgeDir(), { recursive: true });
  const tmp = path.join(bridgeDir(), `open.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify({ path: file, line: line && line > 0 ? Math.floor(line) : undefined, end: line && end && end > line ? Math.floor(end) : undefined, root: root || running.root, ...(side ? { side: true } : {}), at: Date.now() }));
  await rename(tmp, path.join(bridgeDir(), "open.json"));
  heartbeat();
  return { ok: true };
}

/**
 * The layout buttons in Friday's window bar and its search pill, run in VS Code (Arun, 2026-11-19: "we need a button for the
 * bottom panel", "the search bar at the top of the page needs to be designed and fixed and works properly"). Only these: the
 * page names one, the extension runs VS Code's own command for it.
 */
export const VSCODE_COMMANDS = {
  quickOpen: "workbench.action.quickOpen",
  // The search pill: VS Code's command centre list (Go to File, commands, text, symbols, tasks, debug…), as its own title bar does
  // (Arun, 2026-11-19: "make sure all of the VScode control stuff and things also appear in the pop over thing too").
  commandCenter: "workbench.action.quickOpenWithModes",
  sidebar: "workbench.action.toggleSidebarVisibility",
  panel: "workbench.action.togglePanel",
  // The window bar's File menu and the empty editor's rows (Arun, 2026-11-19: "make it very easy to use these commands").
  newTextFile: "workbench.action.files.newUntitledFile",
  newFile: "welcome.showNewFileEntries",
  openFile: "workbench.action.files.openFile",
  save: "workbench.action.files.save",
  saveAs: "workbench.action.files.saveAs",
  saveAll: "workbench.action.files.saveAll",
  revert: "workbench.action.files.revert",
  autoSave: "workbench.action.toggleAutoSave",
  closeEditor: "workbench.action.closeActiveEditor",
  // The chat's branch, every change on it, in the IDE's own diff (the Friday extension's friday.reviewChanges).
  reviewChanges: "friday.reviewChanges",
  // A commit's own diff (find what broke's card): runs with the commit's hash, which vscodeCommand checks.
  openCommit: "friday.openCommit",
  // The footer's task line: the IDE's task board.
  showTasks: "workbench.view.extension.friday",
  // The chat column lies over the IDE's own right side bar (Friday's "Agent" container there), so the IDE's status bar runs under
  // it: showing and hiding the chat opens and closes that bar (Arun, 2026-11-20: "the native vscode footer needs to the be running
  // across the full length of the footer").
  chatOpen: "workbench.view.extension.fridayChat",
  chatClose: "workbench.action.closeAuxiliaryBar",
  // The Stack view (stacked pull requests, the stack card's "Open the stack"): refreshed and shown.
  showStack: "friday.showStack",
  // Friday's palette in the IDE (Arun, 2026-11-19, wave 4): what the page's palette runs there for the rows that are the IDE's own.
  askCodebase: "friday.askCodebase",
  findBreak: "friday.findBreak",
  refactorAcross: "friday.refactorAcross",
  // Friday's one search hands the typed words on to the IDE's own symbol search and Find in Files (Arun, 2026-11-20: "the window
  // bar's search finds files and symbols in the IDE's folder AND Code chats AND Agents sessions, in one list"): they take the words.
  searchSymbols: "friday.searchSymbols",
  searchText: "friday.searchText",
} as const;
export type VsCommand = keyof typeof VSCODE_COMMANDS;
let commandSeq = 0;
/**
 * Which checkout Review changes opens on, when it is not the folder the IDE has open (a racer's copy, Race in Code): the folder
 * and the branch it forked from, and a name for the diff's tab. Anything else is dropped, so the bridge file holds nothing but this.
 */
export interface ReviewArg { dir: string; base?: string; label?: string; /** The pull request's own branch, and that the base is exact (no other branch stands in for it): the session's own pull request. */ head?: string; strict?: boolean }
/** The IDE's own folder (`root`) counts as one too: Review in the IDE on the session's own pull request names the folder the IDE has open, for the base the pull request has. */
export function reviewArg(v: unknown, root?: string): ReviewArg | undefined {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const dir = typeof o?.dir === "string" ? o.dir.trim().slice(0, 600) : "";
  // Only a checkout Friday made: the IDE opens it as a repository, and git reads that folder's own config when it does.
  // The folder the IDE is known to have open, compared as the bridge names folders (rootKey: case only matters on a drive letter or a share).
  const isRoot = !!root && !!dir && rootKey(path.resolve(dir)) === rootKey(path.resolve(root));
  if (!o || !dir || dir.includes("\0") || (!isRoot && !isOwnCheckout(dir))) return undefined;
  // A branch name may carry # + @ too (not a leading dash, not a brace: git reads @{...} as a reflog).
  const refOk = (v: unknown): v is string => typeof v === "string" && /^[\w./+#@-]{1,108}$/.test(v) && !v.startsWith("-");
  const base = refOk(o.base) ? o.base : "";
  const head = refOk(o.head) ? o.head : "";
  const label = typeof o.label === "string" ? o.label.replace(/[\r\n]+/g, " ").trim().slice(0, 60) : "";
  return { dir, ...(base ? { base } : {}), ...(label ? { label } : {}), ...(head ? { head } : {}), ...(o.strict === true ? { strict: true } : {}) };
}

/** A name from VSCODE_COMMANDS (the window bar's buttons), or a command from the Mac menu bar's VS Code menus (src/vscode-menu.ts). */
export async function vscodeCommand(name: string, root?: string, review?: unknown, arg?: string): Promise<{ ok: true }> {
  const command = (VSCODE_COMMANDS as Record<string, string>)[name] ?? (VSCODE_MENU_COMMANDS.has(name) ? name : undefined);
  if (!command) throw new Error("That isn't something Friday asks the IDE to do.");
  if (!running) throw new Error("Friday IDE isn't running.");
  // The one command that takes an argument: a commit's hash, and nothing else (it goes to git).
  if (name === "openCommit" && !/^[0-9a-f]{7,40}$/i.test(arg ?? "")) throw new Error("That isn't a commit hash.");
  // The search hand-offs take the words typed: one line, never a command.
  const words = name === "searchSymbols" || name === "searchText" ? (arg ?? "").replace(/[\r\n\0]+/g, " ").trim().slice(0, 200) : undefined;
  await mkdir(bridgeDir(), { recursive: true });
  const tmp = path.join(bridgeDir(), `command.${process.pid}.tmp`);
  const only = command === VSCODE_COMMANDS.reviewChanges ? reviewArg(review, running.root || root) : undefined;
  // Asked for a folder that isn't one of ours: said, rather than the folder's own diff shown as if it were that one.
  if (review !== undefined && review !== null && command === VSCODE_COMMANDS.reviewChanges && !only) throw new Error("That isn't one of Friday's race copies.");
  await writeFile(tmp, JSON.stringify({ command, ...(name === "openCommit" ? { arg } : {}), ...(words !== undefined ? { arg: words } : {}), root: root || running.root, at: Date.now(), n: ++commandSeq, ...(only ? { review: only } : {}) }));
  await rename(tmp, path.join(bridgeDir(), "command.json"));
  heartbeat();
  return { ok: true };
}

/**
 * Where VS Code finds extensions (Arun, 2026-11-19: "make sure we are able to load all of the extensions offered", with Devin's
 * two marketplace fields as the model). Open VSX by default, code-server's own; another gallery's service and item addresses
 * when the person sets them, passed to code-server as EXTENSIONS_GALLERY. A change restarts VS Code the next time it opens.
 */
export interface VsMarketplace { serviceUrl: string; itemUrl: string }
export const OPEN_VSX: VsMarketplace = { serviceUrl: "https://open-vsx.org/vscode/gallery", itemUrl: "https://open-vsx.org/vscode/item" };
const marketFile = () => path.join(base(), "marketplace.json");
function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" ? u.toString().replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}
async function readMarketplace(): Promise<VsMarketplace | null> {
  try {
    const m = JSON.parse(await readFile(marketFile(), "utf8")) as Record<string, unknown>;
    const serviceUrl = httpsUrl(m.serviceUrl);
    const itemUrl = httpsUrl(m.itemUrl);
    return serviceUrl && itemUrl ? { serviceUrl, itemUrl } : null;
  } catch {
    return null;
  }
}
export async function vscodeMarketplace(): Promise<{ marketplace: VsMarketplace; custom: boolean; default: VsMarketplace }> {
  const m = await readMarketplace();
  return { marketplace: m ?? OPEN_VSX, custom: !!m, default: OPEN_VSX };
}
/** Set (or with null, go back to Open VSX). A running VS Code stops, so the next open starts on the new gallery. */
export async function vscodeSetMarketplace(next: { serviceUrl?: unknown; itemUrl?: unknown } | null): Promise<{ marketplace: VsMarketplace; custom: boolean; default: VsMarketplace }> {
  if (next) {
    const serviceUrl = httpsUrl(next.serviceUrl);
    const itemUrl = httpsUrl(next.itemUrl);
    if (!serviceUrl) throw new Error("The gallery service needs a full https:// address.");
    if (!itemUrl) throw new Error("The gallery item address needs a full https:// address.");
    await mkdir(base(), { recursive: true });
    if (serviceUrl === OPEN_VSX.serviceUrl && itemUrl === OPEN_VSX.itemUrl) await rm(marketFile(), { force: true });
    else await writeFile(marketFile(), JSON.stringify({ serviceUrl, itemUrl }, null, 2) + "\n");
  } else await rm(marketFile(), { force: true });
  if (running || starting) await stopVscode().catch(() => {});
  return vscodeMarketplace();
}

/** Tell the extension which theme Friday is in, so VS Code follows Friday's choice and not only the operating system's. */
export async function vscodeTheme(dark: boolean): Promise<{ ok: true }> {
  await mkdir(bridgeDir(), { recursive: true });
  const tmp = path.join(bridgeDir(), `theme.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify({ theme: dark ? "dark" : "light", at: Date.now() }));
  await rename(tmp, path.join(bridgeDir(), "theme.json"));
  return { ok: true };
}
