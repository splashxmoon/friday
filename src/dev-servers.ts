/**
 * Dev servers Friday manages for a folder (Arun, 2026-11-19, wave 4: "Dev servers managed: Friday starts your app's server, keeps it
 * running across agent runs, shows its port and logs, and restarts it when it crashes."). The pure parts, tested on their own: what a
 * folder declares as a server (package.json scripts, a Procfile, docker compose services) and what to do when one exits (restart with a
 * backoff, three tries, then stop and say so). The runner's side, which starts and keeps the processes, is runner/dev-servers.ts.
 */

export type ServerKind = "script" | "procfile" | "compose";

export interface ServerDef {
  /** Stable across scans: "script:dev", "proc:web", "compose:db". */
  id: string;
  /** What the person calls it: "dev", "web", "api". */
  name: string;
  kind: ServerKind;
  /** The line that is run, as the person would type it: "npm run dev". */
  command: string;
  /** The port it asks for when the folder says (a --port flag, PORT=… in a Procfile, a compose port mapping). */
  port?: number;
}

export interface FolderFiles {
  packageJson?: string;
  procfile?: string;
  compose?: string;
  /** Lock files present, to choose the package manager the project uses. */
  locks?: string[];
}

/** Scripts that mean "serve this project", best first (the same list the Preview uses, runner/preview.ts, plus serve-ish names). */
export const SERVER_SCRIPTS = ["dev", "start", "serve", "preview"];

/** Procfile process types that are not servers to keep running. */
const NOT_SERVERS = new Set(["release", "postdeploy", "predeploy"]);

const manager = (locks: string[] = []): "pnpm" | "yarn" | "npm" => (locks.includes("pnpm-lock.yaml") ? "pnpm" : locks.includes("yarn.lock") ? "yarn" : "npm");

/** A port a command line asks for: `--port 3000`, `--port=3000`, `-p 3000`, `PORT=3000 node …`. */
export function portInCommand(cmd: string): number | undefined {
  const m = /(?:--port[= ]|\s-p[= ]|\bPORT=)(\d{2,5})\b/.exec(cmd);
  const n = m ? Number(m[1]) : 0;
  return n >= 80 && n <= 65535 ? n : undefined;
}

function fromPackage(text: string, locks: string[]): ServerDef[] {
  let declared: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    declared = parsed && typeof parsed === "object" && parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
  } catch {
    return [];
  }
  const pm = manager(locks);
  const run = pm === "npm" ? "npm run" : `${pm} run`;
  return SERVER_SCRIPTS.filter((s) => typeof declared[s] === "string" && (declared[s] as string).trim()).map((s) => ({ id: `script:${s}`, name: s, kind: "script" as const, command: `${run} ${s}`, port: portInCommand(declared[s] as string) }));
}

function fromProcfile(text: string): ServerDef[] {
  const out: ServerDef[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(\S.*)$/.exec(raw.trim());
    if (!m || raw.trim().startsWith("#") || NOT_SERVERS.has(m[1]!)) continue;
    out.push({ id: `proc:${m[1]}`, name: m[1]!, kind: "procfile", command: m[2]!.trim(), port: portInCommand(m[2]!) });
  }
  return out;
}

/**
 * The services of a docker compose file, read without a YAML library: this only needs the names under `services:` and the first
 * published port of each, in the common shapes ("3000:3000", "127.0.0.1:3000:3000", and the long form with `published:`).
 */
export function composeServices(text: string): { name: string; port?: number }[] {
  const out: { name: string; port?: number }[] = [];
  let inServices = false;
  let svcIndent = -1;
  let cur: { name: string; port?: number } | null = null;
  let inPorts = false;
  let portsIndent = 0;
  for (const raw of text.split(/\r?\n/)) {
    const noComment = raw.replace(/\s+#.*$/, "");
    if (!noComment.trim() || noComment.trim().startsWith("#")) continue;
    const indent = noComment.length - noComment.trimStart().length;
    const line = noComment.trim();
    if (indent === 0) {
      inServices = /^services:\s*$/.test(line);
      cur = null;
      inPorts = false;
      continue;
    }
    if (!inServices) continue;
    if (svcIndent < 0) svcIndent = indent;
    if (indent === svcIndent) {
      const m = /^["']?([A-Za-z0-9_.-]+)["']?:\s*$/.exec(line);
      cur = m ? { name: m[1]! } : null;
      if (cur) out.push(cur);
      inPorts = false;
      continue;
    }
    if (!cur) continue;
    if (inPorts && (indent > portsIndent || line.startsWith("-"))) {
      if (cur.port) continue;
      const short = /^-\s*["']?(?:[\d.]+:)?(\d{2,5})(?:-\d+)?:\d{2,5}(?:-\d+)?(?:\/\w+)?["']?\s*$/.exec(line);
      const long = /^(?:-\s*)?published:\s*["']?(\d{2,5})["']?\s*$/.exec(line);
      const n = Number((short ?? long)?.[1] ?? 0);
      if (n) cur.port = n;
      continue;
    }
    inPorts = false;
    if (/^ports:\s*$/.test(line)) {
      inPorts = true;
      portsIndent = indent;
    }
  }
  return out;
}

/** Every server a folder declares: its scripts, its Procfile, its compose services. Never anything the person has not already written down. */
export function detectServers(files: FolderFiles): ServerDef[] {
  const locks = files.locks ?? [];
  const out: ServerDef[] = [];
  if (files.packageJson) out.push(...fromPackage(files.packageJson, locks));
  if (files.procfile) out.push(...fromProcfile(files.procfile));
  if (files.compose) for (const s of composeServices(files.compose)) out.push({ id: `compose:${s.name}`, name: s.name, kind: "compose", command: `docker compose up ${s.name}`, port: s.port });
  const seen = new Set<string>();
  return out.filter((d) => !seen.has(d.id) && !!seen.add(d.id));
}

export type Phase = "starting" | "running" | "restarting" | "crashed" | "stopped";

/** Restarts after a crash: this many, spaced by these waits (ms). A fourth crash in a row is not tried again. */
export const MAX_TRIES = 3;
export const BACKOFF_MS = [1000, 3000, 8000];
/** A server that stayed up this long before it fell over was working: its crashes start counting again from none. */
export const STABLE_MS = 30_000;

export interface ExitFacts {
  /** Restarts already tried in a row. */
  tries: number;
  /** How long it ran before it exited. */
  ranMs: number;
  /** The person stopped it (or stopped it to restart it). */
  stoppedByUser: boolean;
  code: number | null;
  signal?: string | null;
}

export interface ExitVerdict {
  phase: Phase;
  tries: number;
  /** When restarting: the wait before the next start, and which try it is. */
  delayMs?: number;
  try?: number;
  /** What to write in its log and tell the person, in plain words. */
  say: string;
}

/** What follows a server's exit. A clean end by itself is not a crash: some "servers" are one-off scripts, and are left ended. */
export function afterExit(f: ExitFacts): ExitVerdict {
  if (f.stoppedByUser) return { phase: "stopped", tries: 0, say: "— stopped" };
  const how = f.code === null ? `signal ${f.signal ?? "unknown"}` : `code ${f.code}`;
  if (f.code === 0) return { phase: "stopped", tries: 0, say: "— finished by itself (exit code 0)" };
  const tries = f.ranMs >= STABLE_MS ? 0 : f.tries;
  if (tries >= MAX_TRIES) return { phase: "crashed", tries, say: `— crashed again (${how}); gave up after ${MAX_TRIES} restarts. Start it again from the Servers view.` };
  const delayMs = BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]!;
  const n = tries + 1;
  return { phase: "restarting", tries: n, delayMs, try: n, say: `— crashed (${how}); restarting in ${delayMs / 1000}s (try ${n} of ${MAX_TRIES})` };
}
