import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { childEnv, childPath } from "./adapters.js";
import { folderVars } from "./environment.js";

/**
 * Running the thing, not just reading it.
 *
 * A coding session can start the project's own dev server on the machine the
 * agent works on, and show it. Two rules keep this from being "run anything you
 * like on someone's laptop": the command can only be a script the project
 * already declares in its package.json, or Friday's own static file server for
 * a folder of HTML. Nothing typed by whoever is driving is ever run.
 */

export interface PreviewInfo {
  cwd: string;
  /** What was started, in words: "npm run dev" or "static files". */
  command: string;
  port: number;
  /** Where it answers on that machine. */
  url: string;
  startedAt: number;
  /** Recent output, for when it fails to come up. */
  log: string[];
  ready: boolean;
  /** What it is doing before it answers: fetching dependencies, then starting. */
  stage?: "installing" | "starting";
}

interface Running {
  info: PreviewInfo;
  child?: ChildProcess;
  server?: http.Server;
}

const running = new Map<string, Running>();
const LOG_LINES = 60;
/** Scripts that mean "serve this project", best first. */
const SCRIPTS = ["dev", "start", "preview", "serve"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** What this project offers: its serve-ish scripts, and whether it's just files. */
export async function previewOptions(cwd: string): Promise<{ scripts: string[]; static: boolean }> {
  const pkg = await readFile(path.join(cwd, "package.json"), "utf8").catch(() => "");
  let scripts: string[] = [];
  if (pkg) {
    try {
      const declared = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
      scripts = SCRIPTS.filter((s) => declared[s]);
    } catch {
      scripts = [];
    }
  }
  return { scripts, static: await exists(path.join(cwd, "index.html")) };
}

/**
 * What starting the preview would run here, in the words a person approves it in: the script startPreview would pick,
 * after the install it would do first. Nothing when it would run nothing: a preview already up, a folder of HTML, or a
 * script the project doesn't declare (which startPreview refuses).
 */
export async function previewCommand(cwd: string, script?: string): Promise<string | null> {
  if (running.has(cwd)) return null;
  const { scripts } = await previewOptions(cwd);
  const chosen = script ?? scripts[0];
  if (!chosen || !scripts.includes(chosen)) return null;
  return (await needsInstall(cwd)) ? `${await packageManager(cwd)} install && npm run ${chosen}` : `npm run ${chosen}`;
}

/** A plain file server, so a folder of HTML previews without installing anything. */
async function serveStatic(cwd: string, port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      let file = path.resolve(cwd, rel);
      // Never serve outside the folder being previewed.
      if (file !== cwd && !file.startsWith(cwd + path.sep)) return void res.writeHead(403).end("Outside the preview folder");
      if (await stat(file).then((s) => s.isDirectory(), () => false)) file = path.join(file, "index.html");
      if (!(await exists(file))) {
        // Single-page apps route in the browser; fall back to index.html.
        const spa = path.join(cwd, "index.html");
        if (!(await exists(spa))) return void res.writeHead(404).end("Not found");
        file = spa;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String((e as Error).message));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

/** Start (or return) the preview for a folder. `script` must be one it declares. */
/**
 * @param envBase What the dev server's environment is built from. Defaults to
 * this process's, which is right on somebody's own machine and wrong on
 * Friday's server — an uploaded project's dev server has no business seeing
 * Friday's keys, so the caller passes a built environment there instead.
 */
export async function startPreview(cwd: string, script?: string, envBase?: NodeJS.ProcessEnv, staticOnly = false, opts: { install?: boolean } = {}): Promise<PreviewInfo> {
  const current = running.get(cwd);
  if (current) return current.info;

  const options = await previewOptions(cwd);
  const port = await freePort();
  const log: string[] = [];

  if (script && !options.scripts.includes(script)) throw new Error(`This project has no "${script}" script. It offers: ${options.scripts.join(", ") || "none"}.`);
  // Serving files is not running code. A caller that may not run code asks
  // for this explicitly, because leaving the script out is not the same
  // thing — with no script named, the first one in package.json is chosen.
  if (staticOnly && !options.static) throw new Error("Nothing to serve here: no index.html, and this folder's dev server can't be run.");
  const chosen = staticOnly ? undefined : (script ?? options.scripts[0]);

  if (!chosen) {
    if (!options.static) throw new Error("Nothing to preview here: no dev/start/preview script in package.json, and no index.html.");
    const server = await serveStatic(cwd, port);
    const info: PreviewInfo = { cwd, command: "static files", port, url: `http://localhost:${port}`, startedAt: Date.now(), log, ready: true };
    running.set(cwd, { info, server });
    return info;
  }

  // PORT is what most dev servers read; the ones that don't announce their own
  // port in the output, which is picked up below.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const info: PreviewInfo = { cwd, command: `npm run ${chosen}`, port, url: `http://localhost:${port}`, startedAt: Date.now(), log, ready: false, stage: "starting" };
  const entry: Running = { info };
  running.set(cwd, entry);

  // A project fresh from a download or a git clone has no node_modules, and
  // "vite: not found" is all its dev script can say. When the caller may run
  // code (the agent, on a machine whose host allowed commands), fetch them first.
  if (opts.install && (await needsInstall(cwd))) {
    const pm = await packageManager(cwd);
    info.stage = "installing";
    info.command = `${pm} install, then npm run ${chosen}`;
    const code = await runToEnd(pm, pm === "npm" ? ["install", "--no-audit", "--no-fund"] : ["install"], cwd, { ...childEnv(envBase), PATH: childPath(), CI: "1" }, log, INSTALL_MS);
    if (running.get(cwd) !== entry) throw new Error("The preview was stopped while dependencies were installing.");
    if (code !== 0) {
      running.delete(cwd);
      throw new Error(`${pm} install ${code === null ? "took too long and was stopped" : `failed (exit ${code})`}.\n${log.slice(-8).join("\n")}`);
    }
    info.stage = "starting";
    info.command = `npm run ${chosen}`;
  }

  const child = spawn(npm, ["run", chosen], {
    cwd,
    env: { ...childEnv(envBase), ...folderVars(cwd), PORT: String(port), BROWSER: "none", PATH: childPath() },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    // Its own process group on macOS and Linux, so stopping it stops everything the script started (stopPreview).
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  entry.child = child;

  const note = (b: Buffer) => {
    for (const raw of b.toString().split("\n")) {
      // Dev servers colour their output, and Vite puts the colour codes inside
      // the address ("localhost:␛[1m5174"), so the port was never read and the
      // panel watched a port nothing was on. Plain text first, then look.
      const line = stripAnsi(raw);
      if (!line.trim()) continue;
      log.push(line.slice(0, 500));
      if (log.length > LOG_LINES) log.shift();
      // "Local: http://localhost:5173/" — believe the server over our PORT guess.
      const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/i);
      if (m) {
        info.port = Number(m[1]);
        info.url = `http://localhost:${info.port}`;
      }
    }
  };
  child.stdout?.on("data", note);
  child.stderr?.on("data", note);
  child.on("exit", (code) => {
    log.push(`— exited with code ${code}`);
    info.ready = false;
    if (running.get(cwd)?.child === child) running.delete(cwd);
  });

  // Wait for it to actually answer, so the panel doesn't show a blank frame.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const host = await reachableAt(info.port);
    if (host) {
      // Vite and friends listen on "localhost", which on current Node is ::1
      // alone: answering there is as good as answering anywhere.
      // Said as "localhost" whichever loopback answered: the same place, and the name people recognise.
      info.url = `http://localhost:${info.port}`;
      info.ready = true;
      return info;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (child.exitCode !== null) {
    running.delete(cwd);
    throw new Error(`${info.command} exited before serving anything.\n${log.slice(-8).join("\n")}`);
  }
  return info; // still starting; the panel polls status
}

function reachable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(400, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Which loopback address answers on this port, if either does. */
export async function reachableAt(port: number): Promise<"127.0.0.1" | "::1" | null> {
  if (await reachable(port, "127.0.0.1")) return "127.0.0.1";
  if (await reachable(port, "::1")) return "::1";
  return null;
}

const INSTALL_MS = 6 * 60_000;

// Terminal colour and cursor sequences: ESC, "[", parameters, a final letter.
// Built from the character code so the pattern carries no escapes of its own.
const ANSI = new RegExp(`${String.fromCharCode(27)}[[][0-9;?]*[ -/]*[@-~]`, "g");

/** What a terminal would show, without the codes that colour it (and without a trailing carriage return). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "").replace(new RegExp(String.fromCharCode(13), "g"), "");
}

/** Dependencies are declared and not there. */
async function needsInstall(cwd: string): Promise<boolean> {
  if (await exists(path.join(cwd, "node_modules"))) return false;
  try {
    const p = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
    return Object.keys(p.dependencies ?? {}).length + Object.keys(p.devDependencies ?? {}).length > 0;
  } catch {
    return false;
  }
}

/** The package manager the project's lockfile says it uses. */
async function packageManager(cwd: string): Promise<"npm" | "pnpm" | "yarn"> {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Run a command to the end, keeping its last lines for the panel. null if it had to be stopped. */
function runToEnd(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string[], ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(process.platform === "win32" ? `${cmd}.cmd` : cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
    const note = (b: Buffer) => {
      for (const raw of b.toString().split("\n")) {
        const line = stripAnsi(raw);
        if (!line.trim()) continue;
        log.push(line.slice(0, 500));
        if (log.length > LOG_LINES) log.shift();
      }
    };
    c.stdout?.on("data", note);
    c.stderr?.on("data", note);
    const t = setTimeout(() => {
      c.kill("SIGTERM");
      resolve(null);
    }, ms);
    c.on("error", () => {
      clearTimeout(t);
      resolve(1);
    });
    c.on("exit", (code) => {
      clearTimeout(t);
      resolve(code ?? 1);
    });
  });
}

/**
 * The preview's status, after a fresh look at whether it is answering.
 *
 * Starting a preview watches for the server for a minute and then stops
 * watching. A server that took longer — a first run that compiled for a while,
 * a machine under load — was left marked "starting" for good, and the panel
 * waited on it for ever beside a site that was up. Every time somebody asks,
 * this looks again.
 */
export async function previewStatusLive(cwd: string): Promise<PreviewInfo | null> {
  const r = running.get(cwd);
  if (!r) return null;
  const { info } = r;
  if (!info.ready && (r.server || (r.child && r.child.exitCode === null))) {
    const host = await reachableAt(info.port);
    if (host) {
      // Said as "localhost" whichever loopback answered: the same place, and the name people recognise.
      info.url = `http://localhost:${info.port}`;
      info.ready = true;
    }
  }
  return info;
}

export function previewStatus(cwd: string): PreviewInfo | null {
  return running.get(cwd)?.info ?? null;
}

export function stopPreview(cwd: string): boolean {
  const r = running.get(cwd);
  if (!r) return false;
  running.delete(cwd);
  const pid = r.child?.pid;
  // On Windows the script runs under a shell, and killing the shell leaves the
  // dev server it started running — holding its port and its folder open.
  if (pid && process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  // Elsewhere the same holds where /bin/sh is dash (Ubuntu, Debian): npm's shell doesn't hand itself over to the script, so
  // killing npm left the dev server running. The script runs in its own process group (startPreview): the whole group goes.
  else if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      r.child?.kill("SIGTERM");
    }
  }
  r.server?.close();
  return true;
}

export function stopAllPreviews(): void {
  for (const cwd of [...running.keys()]) stopPreview(cwd);
}

/**
 * Fetch one thing from a running preview, for a Friday that isn't on this
 * machine: it can't reach 127.0.0.1 here, so the bytes travel over the link.
 */
export async function fetchPreview(port: number, urlPath: string, asked?: unknown): Promise<{ status: number; type: string; body: string; location?: string }> {
  const p = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  // The dev server may be on IPv4 or only on IPv6; ask whichever answers. Neither: say so now, not when the wait runs out.
  const host = await reachableAt(port);
  if (!host) throw new Error(NOT_LISTENING);
  // Under the two minutes Friday waits for it, so the answer is this one's and not a bare timeout.
  const res = await fetch(`http://${host === "::1" ? "[::1]" : host}:${port}${p}`, { redirect: "manual", signal: AbortSignal.timeout(110_000), headers: previewHeadersFrom(asked) });
  const buf = Buffer.from(await res.arrayBuffer());
  const location = res.headers.get("location");
  return { status: res.status, type: res.headers.get("content-type") ?? "application/octet-stream", body: buf.toString("base64"), ...(location ? { location } : {}) };
}

/**
 * The request headers a previewed page's own requests carry through to its dev server: the ones Next's router sends with a
 * client-side navigation, without which it answers with the whole page and the click becomes a full reload. Nothing else.
 */
export const PREVIEW_HEADERS = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url"];

/** Of what was asked for, only PREVIEW_HEADERS with a short string value. */
export function previewHeadersFrom(asked: unknown): Record<string, string> {
  const got: Record<string, string> = {};
  if (!asked || typeof asked !== "object") return got;
  for (const h of PREVIEW_HEADERS) {
    const v = (asked as Record<string, unknown>)[h];
    if (typeof v === "string" && v.length <= 16_000) got[h] = v;
  }
  return got;
}

export const NOT_LISTENING = "Nothing is listening on that port.";

/** How long Friday waits for one page of a preview on a linked machine. */
export const PREVIEW_FETCH_MS = 120_000;

/** A dev server's redirect, pointed back inside the preview's prefix when it is to the same server. */
export function previewLocation(location: string, port: number, prefix: string): string {
  if (location.startsWith("/") && !location.startsWith("//")) return `${prefix}${location}`;
  try {
    const u = new URL(location);
    const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname) && Number(u.port || 80) === port;
    return local ? `${prefix}${u.pathname}${u.search}${u.hash}` : location;
  } catch {
    // Relative to the page: the browser resolves it inside the prefix already.
    return location;
  }
}

/** Why a preview page didn't come, in words for the frame. */
export function previewTrouble(message: string): string {
  if (message.includes(NOT_LISTENING) || /ECONNREFUSED|fetch failed/i.test(message)) {
    return "Nothing is running there. A dev server a coding tool started can stop when the tool's command ends.";
  }
  if (/didn't answer in time|timeout|aborted/i.test(message)) {
    return "It didn't answer in two minutes. A first build can be that slow: reload to wait again.";
  }
  return message;
}
