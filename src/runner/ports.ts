import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { worktreeRoot } from "./git.js";

/**
 * The web servers running on this computer, read from the system rather than from what Friday started (Arun, 2026-10-18:
 * "the dev servers not appearing in the environment and in the preview servers button"). Both lists only knew Friday's own
 * preview and the commands Friday's background tool started in exactly the session's folder, so a dev server Claude Code or
 * Codex started from its own shell, one started in a terminal, or one an agent ran in its separate copy of the folder was
 * never listed, though it was right there on localhost.
 *
 * Every port something listens on locally, with the process behind it and the folder it runs in; kept when it answers HTTP
 * (a database or a cache doesn't) and either runs in this project (its folder, a folder inside it, or an agent's copy of
 * it) or is plainly a dev server somewhere else on the computer. Nothing here starts anything; stopServer stops one of these
 * when somebody presses its stop button in the Preview's server menu.
 */

export interface LocalServer {
  port: number;
  url: string;
  pid: number;
  /** The process's command line, shortened: "node node_modules/.bin/vite". */
  command: string;
  /** The folder it runs in, when the system says (not on Windows). */
  cwd: string | null;
  /** It runs in this session's folder, a folder inside it, or an agent's copy of it. */
  here: boolean;
}

const run = (cmd: string, args: string[], timeout = 4000) =>
  new Promise<string>((resolve) => execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_e, out) => resolve(String(out ?? ""))));

/** Local addresses only: something listening on every interface is reachable here too; one bound to another address isn't. */
const LOCAL = /^(?:\*|0\.0\.0\.0|127\.\d+\.\d+\.\d+|localhost|\[?::1?\]?|\[?::ffff:127\.\d+\.\d+\.\d+\]?)$/i;

/** What a dev server's command looks like, for one running outside the project: Friday lists those, not every app with a port. */
const DEV = /\b(?:node|bun|deno|npm|npx|pnpm|yarn|vite|next|nuxt|astro|remix|webpack|parcel|esbuild|turbo|nx|expo|metro|react-scripts|vue-cli-service|ng|svelte-kit|storybook|python\d*(?:\.\d+)?|uvicorn|gunicorn|flask|django|manage\.py|rails|puma|ruby|php|artisan|java|gradle|mvn|spring|dotnet|go|air|cargo|trunk|hugo|jekyll|eleventy|http-server|serve|live-server|wrangler|vercel|netlify|firebase|supabase)\b/i;

/** Apps that serve HTTP on localhost but aren't anyone's project: a model server, a database's console, an editor's helper. */
const NOT_DEV = /\b(?:ollama|lm-?studio|llama-server|redis|postgres|mysqld|mongod|docker|com\.docker|spotify|dropbox|controlcenter|rapportd|code helper|cursor helper|electron|figma_agent|adobe|steam)\b/i;

interface Raw {
  pid: number;
  name: string;
  host: string;
  port: number;
}

/** macOS and Linux: lsof's field output, a "p" line per process, then "c" its name and an "n" per address it listens on. */
export function parseLsof(out: string): Raw[] {
  const rows: Raw[] = [];
  let pid = 0;
  let name = "";
  for (const line of out.split("\n")) {
    const tag = line[0];
    const v = line.slice(1).trim();
    if (tag === "p") (pid = Number(v)), (name = "");
    else if (tag === "c") name = v;
    else if (tag === "n") {
      const at = v.lastIndexOf(":");
      const port = Number(v.slice(at + 1));
      const host = v.slice(0, at);
      if (pid && port && LOCAL.test(host)) rows.push({ pid, name, host, port });
    }
  }
  return rows;
}

/** Windows: netstat's TCP table, the LISTENING rows, with the process id in the last column. */
export function parseNetstat(out: string): Raw[] {
  const rows: Raw[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || !/LISTEN/i.test(cols[3] ?? "")) continue;
    const local = cols[1] ?? "";
    const at = local.lastIndexOf(":");
    const port = Number(local.slice(at + 1));
    const host = local.slice(0, at);
    const pid = Number(cols[4]);
    if (pid && port && LOCAL.test(host)) rows.push({ pid, name: "", host, port });
  }
  return rows;
}

/** A shorter command line for a list: the program's name rather than its whole path, and no more than a line. */
export function shortCommand(cmd: string): string {
  // A quoted program is one word, spaces and all ("C:\Program Files\nodejs\node.exe").
  const q = /^"([^"]+)"\s*(.*)$/.exec(cmd.trim());
  const parts = q ? [q[1]!, ...q[2]!.split(/\s+/).filter(Boolean)] : cmd.trim().split(/\s+/);
  parts[0] = (parts[0] ?? "").split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
  // node /path/to/project/node_modules/.bin/vite → node …/.bin/vite
  const out = parts.map((p) => (p.includes("node_modules") ? p.replace(/^.*?(node_modules)/, "…/$1") : p)).join(" ");
  return out.length > 120 ? `${out.slice(0, 119)}…` : out;
}

/** Does the port answer HTTP? Any answer counts, a 404 included: only something that isn't a web server stays silent. */
function answersHttp(host: string, port: number, ms = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: ms, headers: { "User-Agent": "Friday-port-check" } }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => (req.destroy(), resolve(false)));
    req.on("error", () => resolve(false));
  });
}

async function processes(pids: number[]): Promise<Map<number, { command: string; cwd: string | null }>> {
  const out = new Map<number, { command: string; cwd: string | null }>();
  if (!pids.length) return out;
  if (process.platform === "win32") {
    const ps = `Get-CimInstance Win32_Process -Filter "${pids.map((p) => `ProcessId=${p}`).join(" OR ")}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const text = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 6000);
    try {
      const rows = JSON.parse(text || "[]") as { ProcessId: number; CommandLine: string | null } | { ProcessId: number; CommandLine: string | null }[];
      for (const r of Array.isArray(rows) ? rows : [rows]) out.set(r.ProcessId, { command: r.CommandLine ?? "", cwd: null });
    } catch {
      // Without the command lines the ports still list, by their process ids.
    }
    return out;
  }
  const list = pids.join(",");
  const [cmds, cwds] = await Promise.all([run("ps", ["-o", "pid=,command=", "-p", list]), run("lsof", ["-a", "-d", "cwd", "-p", list, "-Fpn"])]);
  for (const line of cmds.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), { command: m[2]!, cwd: null });
  }
  let pid = 0;
  for (const line of cwds.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) out.set(pid, { command: out.get(pid)?.command ?? "", cwd: line.slice(1) });
  }
  return out;
}

/** The repository a folder belongs to, by its shared git folder: an agent's copy of a project has the project's. */
const commonDirs = new Map<string, Promise<string>>();
function commonDir(dir: string): Promise<string> {
  let p = commonDirs.get(dir);
  if (!p) {
    p = run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], 3000).then((s) => s.trim());
    commonDirs.set(dir, p);
    if (commonDirs.size > 200) commonDirs.delete(commonDirs.keys().next().value!);
  }
  return p;
}

const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

const inside = (dir: string, root: string) => {
  const rel = path.relative(root, dir);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Whether a server running in `dir` is this project's: in its folder or below, or in an agent's copy of the same repository. */
async function belongs(dir: string | null, command: string, folder: string): Promise<boolean> {
  if (!dir) return process.platform === "win32" && command.toLowerCase().includes(folder.toLowerCase());
  // The system names the real folder (/private/var/… on a Mac for /var/…), so both are compared as real paths.
  dir = real(dir);
  folder = real(folder);
  if (inside(dir, folder)) return true;
  // An agent's copy and the project it was made from, either way round: the session may be looking from either.
  const trees = real(worktreeRoot());
  if (!inside(dir, trees) && !inside(folder, trees)) return false;
  const [a, b] = await Promise.all([commonDir(dir), commonDir(folder)]);
  return !!a && a === b;
}

let cache: { at: number; folder: string; value: Promise<LocalServer[]> } | null = null;

/** The servers for `folder`: this project's first, then other dev servers on the computer. Asked often, so kept for a moment. */
export function listServers(folder: string): Promise<LocalServer[]> {
  const base = path.resolve(folder);
  if (cache && cache.folder === base && Date.now() - cache.at < 2000) return cache.value;
  const value = scan(base);
  cache = { at: Date.now(), folder: base, value };
  return value;
}

async function scan(folder: string): Promise<LocalServer[]> {
  const win = process.platform === "win32";
  const raw = win ? parseNetstat(await run("netstat", ["-ano", "-p", "TCP"])) : parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]));
  // Friday's own ports (this runner's local API, its live views) aren't the person's servers.
  const rows = raw.filter((r) => r.pid !== process.pid);
  const byPort = new Map<number, Raw>();
  for (const r of rows) if (!byPort.has(r.port)) byPort.set(r.port, r);
  const procs = await processes([...new Set([...byPort.values()].map((r) => r.pid))]);
  const found = await Promise.all(
    [...byPort.values()].map(async (r): Promise<LocalServer | null> => {
      const p = procs.get(r.pid);
      const command = p?.command || r.name;
      const here = await belongs(p?.cwd ?? null, command, folder);
      if (!here && (!DEV.test(command) || NOT_DEV.test(command))) return null;
      const host = /::1/.test(r.host) ? "::1" : "127.0.0.1";
      if (!(await answersHttp(host, r.port))) return null;
      return { port: r.port, url: `http://localhost:${r.port}`, pid: r.pid, command: shortCommand(command), cwd: p?.cwd ?? null, here };
    }),
  );
  return found.filter((s): s is LocalServer => !!s).sort((a, b) => Number(b.here) - Number(a.here) || a.port - b.port);
}

/**
 * Stop the server listening on `port`, from the Preview's server menu: only one this list shows (a web server in this project
 * or a dev server elsewhere on the computer), never this runner or what started it, looked up afresh so a port that changed
 * hands since the menu was drawn isn't the one stopped. Asked to end first; ended outright if it is still there 3s later.
 */
export async function stopServer(folder: string, port: number): Promise<{ stopped: boolean; error?: string }> {
  cache = null;
  const s = (await listServers(folder)).find((x) => x.port === port);
  if (!s) return { stopped: false, error: `Nothing Friday knows of is serving localhost:${port} any more.` };
  if (s.pid === process.pid || s.pid === process.ppid) return { stopped: false, error: "That's Friday itself." };
  const alive = () => {
    try {
      process.kill(s.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    if (process.platform === "win32") await run("taskkill", ["/PID", String(s.pid), "/T"]);
    else process.kill(s.pid, "SIGTERM");
  } catch (e) {
    return { stopped: false, error: `Couldn't stop it: ${(e as Error).message}` };
  }
  for (let i = 0; i < 30 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive()) {
    if (process.platform === "win32") await run("taskkill", ["/PID", String(s.pid), "/T", "/F"]);
    else {
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {
        /* gone in the meantime */
      }
    }
  }
  cache = null;
  return { stopped: true };
}
