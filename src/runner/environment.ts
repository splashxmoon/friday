import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { arch, cpus, homedir, hostname, platform, release, totalmem } from "node:os";
import path from "node:path";
import { childEnv } from "./adapters.js";

/**
 * A session's environment, on the machine its agents work on (Arun, 2026-10-18): what that computer is, which of the
 * project's tools are installed and at what version, the variables the project's .env files name, and what this computer
 * keeps for the folder: a setup command (run once, now or whenever an agent starts here) and variables handed to everything
 * the agents run. The Environment button in a session's status bar shows it (client/Environment.tsx).
 *
 * As the coding tools do it (Codex's setup script and variables, Cursor's environment.json install step, Claude Code's
 * environment variables and setup script), but for a folder on somebody's own computer: nothing is a VM, nothing is snapshot,
 * and what is kept never leaves the machine. Its values aren't in the repository and are never sent to Friday: only their
 * names are said.
 */

export interface ToolVersion {
  /** "Node.js", "pnpm", "Python", "Xcode". */
  name: string;
  /** "22.12.0", or null when it isn't installed. */
  version: string | null;
  /** What the project asks for (an .nvmrc, engines.node, .python-version), when it does. */
  wants?: string;
  /** Why it is listed: "package.json", "pnpm-lock.yaml"... */
  why: string;
}

export interface EnvironmentInfo {
  machine: { name: string; os: string; arch: string; cpus: number; memoryGb: number; shell: string };
  folder: string;
  tools: ToolVersion[];
  /** The variables the folder's .env files set, by file: names only, values never. */
  envFiles: { file: string; names: string[] }[];
  /** What this computer keeps for the folder (saveEnvironment): its setup command, and its variables' names only. */
  saved: { setup: string; autoSetup: boolean; vars: string[]; updatedAt?: number };
  /** Commands the agents run here can reach the internet: it is the person's own computer, with no sandbox between. */
  network: "full";
}

interface Saved {
  setup?: string;
  autoSetup?: boolean;
  vars?: Record<string, string>;
  updatedAt?: number;
}

const DIR = () => path.join(homedir(), ".friday", "environments");
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Variables a folder's settings may not replace: what makes a shell find its tools, and Friday's own. */
const KEEP = new Set(["PATH", "HOME", "USER", "SHELL", "TMPDIR", "PWD"]);

/**
 * The folder whose settings these are: a separate copy (a worktree an agent was given) shares its repository's, so a
 * variable set for a project reaches every agent working on it, in its own copy or not.
 */
function home(cwd: string): string {
  const base = path.resolve(cwd);
  try {
    let dir = base;
    for (let i = 0; i < 40; i++) {
      const git = path.join(dir, ".git");
      if (existsSync(git)) {
        // A worktree's .git is a file naming its repository's: gitdir: /repo/.git/worktrees/name
        if (statSync(git).isFile()) {
          const m = readFileSync(git, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
          const common = m ? path.resolve(dir, m[1]!).split(`${path.sep}.git${path.sep}worktrees${path.sep}`)[0] : null;
          if (common) return common;
        }
        return dir;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* the folder itself, then */
  }
  return base;
}

const fileFor = (cwd: string) => path.join(DIR(), `${createHash("sha1").update(home(cwd)).digest("hex").slice(0, 16)}.json`);

const cache = new Map<string, { at: number; saved: Saved }>();

function readSaved(cwd: string): Saved {
  const file = fileFor(cwd);
  try {
    const at = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.at === at) return hit.saved;
    const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
    cache.set(file, { at, saved });
    return saved;
  } catch {
    return {};
  }
}

/**
 * The variables kept for this folder, to put in the environment of whatever the agents run here: their commands, the dev
 * server, background commands and the coding tools themselves. Laid over what the runner has, never over PATH or HOME.
 */
export function folderVars(cwd: string | undefined): Record<string, string> {
  if (!cwd) return {};
  const vars = readSaved(cwd).vars ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (VAR_NAME.test(k) && !KEEP.has(k) && typeof v === "string") out[k] = v;
  return out;
}

/** The setup command kept for this folder, and whether it runs when an agent starts here. */
export function folderSetup(cwd: string): { setup: string; autoSetup: boolean } {
  const s = readSaved(cwd);
  return { setup: (s.setup ?? "").trim(), autoSetup: !!s.autoSetup && !!s.setup?.trim() };
}

/**
 * Change what this computer keeps for the folder. `vars` is the whole new set when given: a name with an empty value is
 * dropped. Values a caller sent back as `null` keep what they were (the page never holds them, so it sends null for "unchanged").
 */
export function saveEnvironment(cwd: string, change: { setup?: string; autoSetup?: boolean; vars?: Record<string, string | null> }): EnvironmentInfo["saved"] {
  const now = readSaved(cwd);
  const next: Saved = { ...now, updatedAt: Date.now() };
  if (typeof change.setup === "string") next.setup = change.setup.trim().slice(0, 2000);
  if (typeof change.autoSetup === "boolean") next.autoSetup = change.autoSetup;
  if (change.vars && typeof change.vars === "object") {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(change.vars).slice(0, 200)) {
      if (!VAR_NAME.test(k) || KEEP.has(k)) throw new Error(`${k} can't be set here${KEEP.has(k) ? ": it is how commands find their tools" : ": a name is letters, digits and _, not starting with a digit"}.`);
      const value = v === null ? now.vars?.[k] : String(v).slice(0, 20_000);
      if (value) vars[k] = value;
    }
    next.vars = vars;
  }
  mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const file = fileFor(cwd);
  writeFileSync(file, JSON.stringify({ folder: home(cwd), ...next }, null, 2), { mode: 0o600 });
  // Only its owner reads it, whatever the umask made of a file that already existed.
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not on this filesystem */
  }
  cache.delete(file);
  return { setup: next.setup ?? "", autoSetup: !!next.autoSetup, vars: Object.keys(next.vars ?? {}).sort(), ...(next.updatedAt ? { updatedAt: next.updatedAt } : {}) };
}

function version(cmd: string, args: string[], pick: RegExp = /(\d+\.\d+(?:\.\d+)?)/): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: childEnv(), timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024, shell: process.platform === "win32" }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return resolve(null);
      const m = `${stdout}\n${stderr}`.match(pick);
      resolve(m ? m[1]! : null);
    });
  });
}

const has = (cwd: string, f: string) => existsSync(path.join(cwd, f));
const text = (cwd: string, f: string) => readFile(path.join(cwd, f), "utf8").catch(() => "");

/** The tools this project uses, from the files that say so, each with the version installed here. */
async function toolchain(cwd: string): Promise<ToolVersion[]> {
  const top = new Set(await readdir(cwd).catch(() => [] as string[]));
  const any = (...names: string[]) => names.find((n) => top.has(n));
  const pkg = top.has("package.json") ? ((): { engines?: { node?: string }; packageManager?: string } => {
    try {
      return JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    } catch {
      return {};
    }
  })() : null;
  const want: Promise<ToolVersion | null>[] = [version("git", ["--version"]).then((v) => ({ name: "Git", version: v, why: "every folder" }))];
  if (pkg || any(".nvmrc", ".node-version")) {
    const nvmrc = (await text(cwd, ".nvmrc")).trim() || (await text(cwd, ".node-version")).trim();
    const wants = nvmrc || pkg?.engines?.node;
    want.push(version("node", ["--version"]).then((v) => ({ name: "Node.js", version: v, why: "package.json", ...(wants ? { wants } : {}) })));
    const pm = pkg?.packageManager?.split("@")[0];
    if (any("pnpm-lock.yaml") || pm === "pnpm") want.push(version("pnpm", ["--version"]).then((v) => ({ name: "pnpm", version: v, why: "pnpm-lock.yaml" })));
    else if (any("yarn.lock") || pm === "yarn") want.push(version("yarn", ["--version"]).then((v) => ({ name: "Yarn", version: v, why: "yarn.lock" })));
    else if (any("bun.lockb", "bun.lock") || pm === "bun") want.push(version("bun", ["--version"]).then((v) => ({ name: "Bun", version: v, why: "bun.lock" })));
    else want.push(version("npm", ["--version"]).then((v) => ({ name: "npm", version: v, why: "package.json" })));
  }
  if (any("deno.json", "deno.jsonc")) want.push(version("deno", ["--version"]).then((v) => ({ name: "Deno", version: v, why: "deno.json" })));
  const py = any("pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "uv.lock", ".python-version");
  if (py) {
    const wants = (await text(cwd, ".python-version")).trim();
    want.push(version(process.platform === "win32" ? "python" : "python3", ["--version"]).then((v) => ({ name: "Python", version: v, why: py, ...(wants ? { wants } : {}) })));
    if (any("uv.lock")) want.push(version("uv", ["--version"]).then((v) => ({ name: "uv", version: v, why: "uv.lock" })));
    if (any("poetry.lock")) want.push(version("poetry", ["--version"]).then((v) => ({ name: "Poetry", version: v, why: "poetry.lock" })));
  }
  if (any("go.mod")) want.push(version("go", ["version"], /go(\d+\.\d+(?:\.\d+)?)/).then((v) => ({ name: "Go", version: v, why: "go.mod" })));
  if (any("Cargo.toml")) want.push(version("cargo", ["--version"]).then((v) => ({ name: "Rust (cargo)", version: v, why: "Cargo.toml" })));
  if (any("Gemfile")) want.push(version("ruby", ["--version"]).then((v) => ({ name: "Ruby", version: v, why: "Gemfile" })));
  if (any("composer.json")) want.push(version("php", ["--version"]).then((v) => ({ name: "PHP", version: v, why: "composer.json" })));
  if (any("pom.xml", "build.gradle", "build.gradle.kts")) want.push(version("java", ["-version"], /version "?(\d+(?:\.\d+)*)/).then((v) => ({ name: "Java", version: v, why: any("pom.xml", "build.gradle", "build.gradle.kts")! })));
  const apple = [...top].find((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace")) ?? (top.has("Package.swift") ? "Package.swift" : "");
  if (apple && process.platform === "darwin") {
    want.push(version("xcodebuild", ["-version"], /Xcode (\d+(?:\.\d+)*)/).then((v) => ({ name: "Xcode", version: v, why: apple })));
    want.push(version("swift", ["--version"], /Swift version (\d+(?:\.\d+)*)/).then((v) => ({ name: "Swift", version: v, why: apple })));
  }
  if (any("Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml")) want.push(version("docker", ["--version"]).then((v) => ({ name: "Docker", version: v, why: any("Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml")! })));
  return (await Promise.all(want)).filter((t): t is ToolVersion => !!t);
}

/** The names a .env file sets, in order, never their values. */
function envNames(src: string): string[] {
  const names: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

async function osName(): Promise<string> {
  if (process.platform === "darwin") {
    const v = await version("sw_vers", ["-productVersion"], /(\d+(?:\.\d+)*)/);
    return v ? `macOS ${v}` : "macOS";
  }
  if (process.platform === "win32") return `Windows ${release()}`;
  const os = (await readFile("/etc/os-release", "utf8").catch(() => "")).match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
  return os ?? `Linux ${release()}`;
}

/** The shell the agents' commands run in here, by name. */
function shellName(): string {
  if (process.platform === "win32") return "PowerShell or Git Bash";
  return path.basename(process.env.SHELL || "/bin/sh");
}

/** What a session's environment is on this computer, for the folder `cwd`. */
export async function describeEnvironment(cwd: string): Promise<EnvironmentInfo> {
  const base = path.resolve(cwd);
  const [os, tools, files] = await Promise.all([osName(), toolchain(base), readdir(base).catch(() => [] as string[])]);
  const envFiles = await Promise.all(
    files
      .filter((f) => /^\.env(\.[\w.-]+)?$/.test(f))
      .sort()
      .slice(0, 12)
      .map(async (file) => ({ file, names: envNames(await text(base, file)).slice(0, 200) })),
  );
  const saved = readSaved(base);
  return {
    machine: { name: process.env.FRIDAY_MACHINE_NAME || hostname().replace(/\.local$/i, ""), os, arch: arch() === "arm64" && platform() === "darwin" ? "Apple silicon" : arch(), cpus: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), shell: shellName() },
    folder: base,
    tools,
    envFiles,
    saved: { setup: saved.setup ?? "", autoSetup: !!saved.autoSetup, vars: Object.keys(saved.vars ?? {}).sort(), ...(saved.updatedAt ? { updatedAt: saved.updatedAt } : {}) },
    network: "full",
  };
}
