import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterExit, detectServers, type Phase, type ServerDef } from "../dev-servers.js";
import { childEnv } from "./adapters.js";
import { killTree, NON_INTERACTIVE, shellLine } from "./background.js";
import { folderVars } from "./environment.js";
import { own } from "./owned.js";
import { listServers, onStopServer, parseLsof, parseNetstat, stopServer, type LocalServer } from "./ports.js";
import { reachableAt, stripAnsi } from "./preview.js";

/**
 * Dev servers Friday keeps for a folder (Arun, 2026-11-19, wave 4: "Dev servers managed: Friday starts your app's server, keeps it
 * running across agent runs, shows its port and logs, and restarts it when it crashes."; "servers Friday starts are owned by the
 * runner, not the IDE terminal, so a run or an IDE reload doesn't kill them").
 *
 * What may be started is only what the folder already declares (dev-servers.ts: package.json scripts, a Procfile, docker compose
 * services), the rule the Preview keeps too. Each is run by the runner in its own process group, so an agent's run ending or the IDE
 * reloading leaves it going, and it ends only when Friday quits (owned.ts) or the person stops it. When it falls over it is started
 * again after a wait, three times (dev-servers.ts afterExit), and each of those is written into its own log in plain words.
 * An agent's run that wants a page to look at asks reusableServer first, so the one that is up is the one it uses.
 */

export interface ManagedInfo {
  id: string;
  name: string;
  kind: string;
  command: string;
  phase: Phase;
  port: number | null;
  url: string | null;
  pid: number | null;
  /** Restarts tried in a row right now. */
  tries: number;
  startedAt: number | null;
  /** The latest thing worth telling the person: a crash and what Friday did about it. */
  note: string;
  /** Lines logged so far; a reader asks for those after the last one it has. */
  lines: number;
}

interface Entry {
  root: string;
  def: ServerDef;
  child: ChildProcess | null;
  phase: Phase;
  tries: number;
  port: number | null;
  startedAt: number | null;
  note: string;
  log: { n: number; text: string }[];
  lines: number;
  stoppedByUser: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Counts up with every start and stop, so a timer or a readiness look from an earlier run does nothing to a later one. */
  gen: number;
  /** A port its output printed while it was starting; believed only once the process group is seen listening on it. */
  hint: number | null;
  /** The generation whose exit was already handled: a spawn failure reports both "error" and "close". */
  exitedGen: number;
  /** The end of a line still arriving, per stream. */
  tail: { out: string; err: string };
}

const entries = new Map<string, Entry>();
const LOG_LINES = 500;
const LINE_CAP = 600;
// A server that has listened on nothing this long is a worker, shown as running without a port; one that listens later gets its port then.
const PORTLESS_MS = 6_000;
const PORTLESS_COMPOSE_MS = 15_000;
const FAST_MS = 60_000;

/** The real folder: the IDE's fsPath ("c:\\x"), a run's cwd ("C:\\x") and a symlinked path (/tmp for /private/tmp) are one folder. */
const resolveRoot = (root: string) => {
  const abs = path.resolve(root);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
};
const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
const sameRoot = (a: string, b: string) => fold(a) === fold(b);
const key = (root: string, id: string) => `${fold(root)}\0${id}`;

/** One start, stop or restart at a time per server: a second one waits for the first and then sees what it did. */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(k: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(k) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  chains.set(k, tail);
  void tail.then(() => chains.get(k) === tail && chains.delete(k));
  return next;
}

const run = (cmd: string, args: string[]) => new Promise<string>((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_e, out) => resolve(String(out ?? ""))));

/**
 * What a server's process group is doing: every process in it (the shell, npm, the node under it) and the ports they listen on, so a
 * server that listens on a port of its own choosing is found, and a port printed in a log line is checked against what is really open.
 * null when the system can't say (no lsof or ps): the caller falls back to looking at the ports it has a guess for.
 */
async function treeOf(pid: number): Promise<{ pids: Set<number>; ports: number[] } | null> {
  if (process.platform === "win32") {
    const rows = parseNetstat(await run("netstat", ["-ano", "-p", "TCP"]));
    return { pids: new Set([pid]), ports: [...new Set(rows.filter((r) => r.pid === pid).map((r) => r.port))] };
  }
  const ps = await run("ps", ["-A", "-o", "pid=,ppid=,pgid="]);
  const procs = ps.split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((c) => c.length === 3 && c.every(Number.isFinite));
  if (!procs.length) return null;
  const pids = new Set<number>([pid]);
  for (const [p, , g] of procs) if (g === pid) pids.add(p!);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, pp] of procs) if (!pids.has(p!) && pids.has(pp!)) (pids.add(p!), (grew = true));
  }
  const open = parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]));
  return { pids, ports: [...new Set(open.filter((r) => pids.has(r.pid)).map((r) => r.port))].sort((a, b) => a - b) };
}
const exists = (p: string) => stat(p).then(() => true, () => false);
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

/** What the folder declares, read fresh each time: a script added a minute ago is there. */
export async function declaredServers(root: string): Promise<ServerDef[]> {
  const read = (f: string) => readFile(path.join(root, f), "utf8").catch(() => undefined);
  let compose: string | undefined;
  for (const f of COMPOSE_FILES) if ((compose = await read(f)) !== undefined) break;
  const locks: string[] = [];
  for (const f of ["pnpm-lock.yaml", "yarn.lock"]) if (await exists(path.join(root, f))) locks.push(f);
  return detectServers({ packageJson: await read("package.json"), procfile: await read("Procfile"), compose, locks });
}

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

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });

function say(e: Entry, text: string): void {
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    e.log.push({ n: ++e.lines, text: raw.length > LINE_CAP ? `${raw.slice(0, LINE_CAP)}…` : raw });
  }
  if (e.log.length > LOG_LINES) e.log.splice(0, e.log.length - LOG_LINES);
}

/** Output arrives in chunks, not lines: the end of a line that is still coming waits for the rest of it. */
function feed(e: Entry, stream: "out" | "err", chunk: string, flush = false): string {
  const text = e.tail[stream] + chunk;
  const cut = flush ? text.length : text.lastIndexOf("\n") + 1;
  e.tail[stream] = text.slice(cut);
  const whole = text.slice(0, cut);
  if (whole) say(e, whole);
  return whole;
}

const live = (e: Entry) => e.phase === "starting" || e.phase === "running" || e.phase === "restarting";

function info(e: Entry): ManagedInfo {
  return {
    id: e.def.id,
    name: e.def.name,
    kind: e.def.kind,
    command: e.def.command,
    phase: e.phase,
    port: e.port,
    url: e.port ? `http://localhost:${e.port}` : null,
    pid: e.child?.pid ?? null,
    tries: e.tries,
    startedAt: e.startedAt,
    note: e.note,
    lines: e.lines,
  };
}

/** Run it now. Its readiness is looked at in the background: the call answers at once with the server "starting". */
async function launch(e: Entry): Promise<void> {
  const gen = ++e.gen;
  e.stoppedByUser = false;
  e.phase = "starting";
  e.startedAt = Date.now();
  e.hint = null;
  e.tail = { out: "", err: "" };
  const compose = e.def.kind === "compose";
  // No PORT is handed out: the project's own default is the port it should have, so redirect URIs, CORS lists and open tabs keep
  // working (Arun, 2026-11-19, wave 4: "● :3000 web"). Only a PORT the folder sets itself is kept, and moved only when something
  // else already holds it. Where the server really listens is read from its process group below.
  const folder = folderVars(e.root);
  const asked = Number(folder.PORT) || e.def.port || null;
  let give: number | null = null;
  if (compose) e.port = e.def.port ?? null;
  else if (asked) {
    e.port = asked;
    if (!(await portFree(asked)) && folder.PORT) {
      give = await freePort();
      e.port = give;
      say(e, `— port ${asked} is taken, so this one is started on ${give}`);
    }
  }
  // Stopped while looking at the port: nothing was started and nothing should be.
  if (e.gen !== gen) return;
  say(e, `$ ${e.def.command}`);
  const { bin, args } = shellLine(e.def.command);
  const win = process.platform === "win32";
  const env: NodeJS.ProcessEnv = { ...childEnv(), ...folder };
  if (!folder.PORT) delete env.PORT;
  if (give) env.PORT = String(give);
  let child: ChildProcess;
  try {
    child = spawn(bin, args, {
      cwd: e.root,
      env: { ...env, ...NON_INTERACTIVE, BROWSER: "none", NPM_CONFIG_UPDATE_NOTIFIER: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
      detached: !win,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    say(e, `Could not start: ${(err as Error).message}`);
    return void exited(e, gen, 127, null, 0);
  }
  e.child = child;
  const started = Date.now();
  if (child.pid) {
    const pid = child.pid;
    const alive = () => {
      if (win) return child.exitCode === null && child.signalCode === null;
      try {
        return process.kill(-pid, 0);
      } catch {
        return false;
      }
    };
    const off = own({ alive, signal: (sig) => killTree(child, sig) });
    child.once("close", () => !alive() && off());
  }
  const idle: { out?: ReturnType<typeof setTimeout>; err?: ReturnType<typeof setTimeout> } = {};
  const note = (stream: "out" | "err") => (d: string) => {
    if (e.gen !== gen) return;
    const whole = feed(e, stream, d);
    // A prompt that never ends its line is written after a moment rather than held back.
    clearTimeout(idle[stream]);
    if (e.tail[stream]) idle[stream] = setTimeout(() => e.gen === gen && feed(e, stream, "", true), 300);
    // "Local: http://localhost:5173/": a lead on where it listens, believed only while starting and once the port is seen open.
    const m = e.phase === "starting" && !compose ? /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/i.exec(whole) : null;
    if (m) e.hint = Number(m[1]);
  };
  child.stdout?.setEncoding("utf8").on("data", note("out"));
  child.stderr?.setEncoding("utf8").on("data", note("err"));
  child.once("error", (err) => {
    say(e, `Could not start: ${err.message}`);
    exited(e, gen, 127, null, Date.now() - started);
  });
  child.once("close", (code, signal) => {
    if (e.gen === gen) for (const st of ["out", "err"] as const) feed(e, st, "", true);
    exited(e, gen, code, signal, Date.now() - started);
  });
  // Watched for as long as it lives: up when something in its process group listens (or, for a compose service, its published port
  // answers); a slow first build is up when it gets there; one that listens on nothing is a worker, running without a port.
  void (async () => {
    const dead = () => child.exitCode !== null || child.signalCode !== null;
    while (e.gen === gen && !dead()) {
      const age = Date.now() - started;
      let port: number | null = null;
      let open: number[] | null = null;
      if (compose) port = e.def.port && (await reachableAt(e.def.port)) ? e.def.port : null;
      else {
        const t = child.pid ? await treeOf(child.pid) : null;
        open = t ? t.ports.filter((p) => p !== 9229) : null;
        const lead = [e.hint, e.port].filter((p): p is number => !!p);
        if (open) port = lead.find((p) => open!.includes(p)) ?? open[0] ?? null;
        // The system's list can come back empty or late (a busy computer): the port its own output printed is still looked at.
        if (!port) for (const p of lead) if (await reachableAt(p)) (port = p), (open = [p]);
      }
      if (e.gen !== gen || dead()) return;
      if (port) {
        // Up on a port it chose; a server that has moved off the one it had is followed.
        if (e.phase === "starting" || !e.port || (open && !open.includes(e.port))) {
          e.port = port;
          e.phase = "running";
          e.note = e.tries ? `Back up after ${e.tries} restart${e.tries === 1 ? "" : "s"}.` : "";
        }
        return;
      }
      if (e.phase === "starting" && age >= (compose ? PORTLESS_COMPOSE_MS : PORTLESS_MS)) {
        e.phase = "running";
        e.port = compose ? e.def.port ?? null : null;
        e.note = "Running, with no web port to open.";
      }
      await new Promise((r) => setTimeout(r, age < FAST_MS ? 500 : 3000));
    }
  })();
}

function exited(e: Entry, gen: number, code: number | null, signal: string | null, ranMs: number): void {
  if (e.gen !== gen || e.exitedGen === gen) return;
  e.exitedGen = gen;
  e.child = null;
  // Ended from outside by an ordinary "please stop" (the Preview's Stop, a kill in a terminal) is a stop, not a crash to start again.
  const asked = signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGHUP";
  const v = afterExit({ tries: e.tries, ranMs, stoppedByUser: e.stoppedByUser || asked, code, signal });
  e.phase = v.phase;
  e.tries = v.tries;
  say(e, v.say);
  e.note = v.phase === "stopped" ? "" : v.say.replace(/^— /, "");
  if (e.timer) (clearTimeout(e.timer), (e.timer = null));
  if (v.phase === "restarting" && v.delayMs) {
    const mine = e.gen;
    e.timer = setTimeout(() => {
      e.timer = null;
      if (e.gen === mine && e.phase === "restarting") void launch(e);
    }, v.delayMs);
    e.timer.unref?.();
  }
}

const current = (root: string, id: string) => entries.get(key(root, id));

/** Start (or leave going) a server the folder declares. Already starting, running or waiting to restart: nothing new is started. */
export function startManaged(rootIn: string, id: string): Promise<ManagedInfo> {
  const root = resolveRoot(rootIn);
  return serial(key(root, id), () => startNow(root, id));
}

async function startNow(root: string, id: string): Promise<ManagedInfo> {
  const have = current(root, id);
  if (have && live(have)) return info(have);
  const def = (await declaredServers(root)).find((d) => d.id === id);
  if (!def) throw new Error(`This folder declares no server called "${id}".`);
  const e: Entry = have ?? { root, def, child: null, phase: "stopped", tries: 0, port: null, startedAt: null, note: "", log: [], lines: 0, stoppedByUser: false, timer: null, gen: 0, hint: null, exitedGen: -1, tail: { out: "", err: "" } };
  e.def = def;
  e.tries = 0;
  e.note = "";
  entries.set(key(root, id), e);
  await launch(e);
  return info(e);
}

/** Stop it for good (until started again): the process and what it started, and no restart. */
export function stopManaged(rootIn: string, id: string): Promise<ManagedInfo | null> {
  const root = resolveRoot(rootIn);
  return serial(key(root, id), () => stopNow(root, id));
}

async function stopNow(root: string, id: string): Promise<ManagedInfo | null> {
  const e = current(root, id);
  if (!e) return null;
  if (e.timer) (clearTimeout(e.timer), (e.timer = null));
  const child = e.child;
  if (child && live(e)) {
    e.stoppedByUser = true;
    const gone = new Promise<void>((r) => child.once("close", () => r()));
    killTree(child, "SIGTERM");
    const hard = setTimeout(() => {
      if (process.platform !== "win32" || child.exitCode === null) killTree(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, 3000);
    await Promise.race([gone, new Promise<void>((r) => setTimeout(r, 5000))]);
    clearTimeout(hard);
  } else if (live(e)) {
    // Waiting out a backoff, or between "starting" and the spawn: nothing runs, and what is waiting must not start.
    e.gen++;
    e.phase = "stopped";
    e.tries = 0;
    e.note = "";
    say(e, "— stopped");
  }
  return info(e);
}

export function restartManaged(rootIn: string, id: string): Promise<ManagedInfo> {
  const root = resolveRoot(rootIn);
  return serial(key(root, id), async () => {
    await stopNow(root, id);
    const e = current(root, id);
    if (e) e.phase = "stopped";
    return startNow(root, id);
  });
}

// The Preview's Stop on a server Friday keeps (ports.ts stopServer) is a stop here too, so it isn't started again behind the person's back.
onStopServer(async (pid, port) => {
  for (const e of entries.values()) {
    if (!live(e)) continue;
    let mine = e.phase === "running" && e.port === port;
    if (!mine && e.child?.pid) mine = !!(await treeOf(e.child.pid))?.pids.has(pid);
    if (mine) return void (await stopManaged(e.root, e.def.id)), true;
  }
  return false;
});

/**
 * A server of this folder that is up, for whoever wants a page to look at (the preview check, runner/preview-check.ts): the one
 * Friday keeps, so it is used again and no second one is started. Only one that is on its way back up, or just started with a port
 * it is expected on, is given up to `waitMs` to answer: a worker, or a server that never answers there, never holds anyone up.
 */
export async function reusableServer(rootIn: string, waitMs = 0): Promise<{ id: string; name: string; port: number; url: string } | null> {
  const root = resolveRoot(rootIn);
  const until = Date.now() + waitMs;
  for (;;) {
    const mine = [...entries.values()].filter((e) => sameRoot(e.root, root) && live(e) && e.def.kind !== "compose");
    const up = mine.find((e) => e.phase === "running" && e.port);
    if (up) return { id: up.def.id, name: up.def.name, port: up.port!, url: `http://localhost:${up.port}` };
    const coming = mine.some((e) => !!e.port && (e.phase === "restarting" || (e.phase === "starting" && Date.now() - (e.startedAt ?? 0) < 20_000)));
    if (!coming || Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export interface ServersList {
  /** What the folder declares, each with what Friday knows of it running. */
  servers: (ManagedInfo & { managed: boolean })[];
  /** Web servers on this computer that serve this folder but are not Friday's (started in a terminal, by an agent's own tool). */
  external: LocalServer[];
}

const idle = (d: ServerDef): ManagedInfo => ({ id: d.id, name: d.name, kind: d.kind, command: d.command, phase: "stopped", port: d.port ?? null, url: null, pid: null, tries: 0, startedAt: null, note: "", lines: 0 });

export async function listManaged(rootIn: string, withExternal = true): Promise<ServersList> {
  const root = resolveRoot(rootIn);
  const defs = await declaredServers(root);
  const servers = defs.map((d) => {
    const e = current(root, d.id);
    return e ? { ...info(e), managed: true } : { ...idle(d), managed: false };
  });
  // One Friday started that the folder no longer declares is still listed while it runs, so it can be stopped.
  for (const e of entries.values()) if (sameRoot(e.root, root) && live(e) && !defs.some((d) => d.id === e.def.id)) servers.push({ ...info(e), managed: true });
  let external: LocalServer[] = [];
  if (withExternal) {
    const ports = new Set(servers.filter((s) => s.phase !== "stopped" && s.port).map((s) => s.port));
    const pids = new Set(servers.map((s) => s.pid).filter(Boolean));
    external = (await listServers(root).catch(() => [])).filter((s) => s.here && !ports.has(s.port) && !pids.has(s.pid));
  }
  return { servers, external };
}

export function readManagedLog(rootIn: string, id: string, since = 0): { lines: { n: number; text: string }[]; last: number; phase: Phase | "none" } {
  const e = current(resolveRoot(rootIn), id);
  if (!e) return { lines: [], last: 0, phase: "none" };
  // A reader whose cursor is ahead of the log (the server was started afresh, the log began again) starts over.
  const from = since > e.lines ? 0 : since;
  return { lines: e.log.filter((l) => l.n > from), last: e.lines, phase: e.phase };
}

/** The IDE's calls (app.ts /api/vscode/servers). */
export async function serversOp(op: string, p: { root: string; id?: string; port?: number; since?: number; external?: boolean }): Promise<unknown> {
  const root = p.root;
  if (!root) throw new Error("Which folder?");
  switch (op) {
    case "list":
      return listManaged(root, p.external !== false);
    case "start":
      return { server: await startManaged(root, String(p.id ?? "")) };
    case "stop":
      return { server: await stopManaged(root, String(p.id ?? "")) };
    case "restart":
      return { server: await restartManaged(root, String(p.id ?? "")) };
    case "log":
      return readManagedLog(root, String(p.id ?? ""), Number(p.since) || 0);
    // A server somebody else started, ended from the list: only what ports.ts lists for this folder.
    case "stop-port":
      return stopServer(root, Number(p.port) || 0);
    default:
      throw new Error("Unknown call.");
  }
}

/** Nothing Friday started outlives it: the processes are owned (owned.ts), and the waits to restart are let go. */
export function stopAllManaged(): void {
  for (const e of entries.values()) {
    e.gen++;
    if (e.timer) clearTimeout(e.timer);
    if (e.child) killTree(e.child, "SIGKILL");
  }
}
process.once("exit", stopAllManaged);
