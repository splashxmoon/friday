import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { childEnv } from "./adapters.js";
import { folderVars } from "./environment.js";
import { NO_PROMPT } from "./git.js";

/**
 * Commands that keep running while the agent carries on: a test watcher, a build in watch mode, a worker, a log tail.
 *
 * `run_command` waits for a command to finish and stops it at a time limit, which is right for "run the tests" and wrong
 * for "keep the tests running while I change things". A background command is started, given a name, and left going. The
 * agent can read what it has printed since, and stop it. So can a person, from the Tasks panel.
 *
 * It is the same shell the same host allowed for commands, behind the same gate: a machine that cannot run a command
 * cannot start one in the background either. Everything started here dies with the runner, and none of it is started on
 * Friday's own server (an uploaded folder), where a process that outlives its request is not something to hand out.
 */

export interface BackgroundInfo {
  id: string;
  cwd: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  /** Set once it has stopped by itself or been stopped. */
  exitCode?: number | null;
  running: boolean;
  /** Whether it was stopped on purpose, as against ending on its own. */
  stopped?: boolean;
  /** The last of what it printed. */
  log: string[];
}

interface Entry {
  info: BackgroundInfo;
  child: ChildProcess;
  /** Lines that have gone by in total, so a reader can ask for "what's new". */
  lines: number;
}

const entries = new Map<string, Entry>();
let counter = 0;

const LOG_LINES = 400;
const LINE_CAP = 600;
/** Per folder: enough for a server, a watcher and a build, few enough that nothing is lost track of. */
export const MAX_RUNNING = 5;

const key = (cwd: string, id: string) => `${path.resolve(cwd)}\0${id}`;

let foundBash: string | null | undefined;

/**
 * Git Bash, when this Windows machine has Git for Windows, which nearly every machine with a coding agent on it does.
 *
 * Found from where git itself is (`…\Git\cmd\git.exe` or `…\Git\mingw64\bin\git.exe` → `…\Git\bin\bash.exe`), then the
 * usual install folders. Never a bare `bash`, and never anything under Windows' own folder: that one is the WSL launcher,
 * which runs the line in a different machine's filesystem. FRIDAY_BASH names one somewhere else. Looked up once.
 */
function gitBash(): string | null {
  if (foundBash !== undefined) return foundBash;
  const system = path.resolve(process.env.SystemRoot ?? "C:\\Windows").toLowerCase() + path.sep;
  const fromGit = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir && existsSync(path.join(dir, "git.exe")))
    .flatMap((dir) => [path.resolve(dir, "..", "bin", "bash.exe"), path.resolve(dir, "..", "..", "bin", "bash.exe")]);
  const installed = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
    .filter((dir): dir is string => !!dir)
    .map((dir) => path.join(dir, "Git", "bin", "bash.exe"));
  foundBash = [process.env.FRIDAY_BASH, ...fromGit, ...installed].find((p): p is string => !!p && !path.resolve(p).toLowerCase().startsWith(system) && existsSync(p)) ?? null;
  return foundBash;
}

/**
 * Which shell a command line runs in here, for the agent to be told before it writes one: "git-bash" or "powershell" on
 * Windows, "sh" anywhere else.
 */
export function shellName(): "sh" | "git-bash" | "powershell" {
  if (process.platform !== "win32") return "sh";
  return gitBash() ? "git-bash" : "powershell";
}

/**
 * How to hand one command line to the platform's shell.
 *
 * On Windows that is Git Bash when there is one, as Claude Code does: a model writes POSIX shell, and cmd.exe answered
 * `ls`, `cat`, `$(…)` and single quotes with "not recognized" or, worse, with an exit 0 and nothing done. Node's ordinary
 * argument quoting is what MSYS expects, so the line goes as one argument. Without Git Bash it is Windows PowerShell,
 * which is on every Windows machine and is the shell the desktop terminal opens. Around the line: no progress records
 * (piped, PowerShell writes them to stderr as XML), output in UTF-8, which is how it is read, and the exit code of a
 * program that failed rather than PowerShell's own 1. Not -EncodedCommand, which turns every error into XML too.
 * RemoteSigned for this one process only, so `npm`, which PowerShell finds as npm.ps1, is allowed to run.
 */
export function shellLine(command: string): { bin: string; args: string[] } {
  if (process.platform !== "win32") return { bin: "/bin/sh", args: ["-c", command] };
  const bash = gitBash();
  if (bash) return { bin: bash, args: ["-c", command] };
  const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }`;
  return { bin: ps, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", script] };
}

/**
 * Nothing a command starts may stop to ask a question. Nobody can answer it: its input is closed, and a prompt only
 * holds the run until it times out. A push that wants a password fails at once, Git Credential Manager does not open a
 * sign-in window on the host's screen, and git takes the message it was given instead of opening an editor.
 */
export const NON_INTERACTIVE = { ...NO_PROMPT, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", GIT_PAGER: "cat", PAGER: "cat" };

function push(e: Entry, chunk: string): void {
  for (const raw of chunk.split(/\r?\n/)) {
    if (!raw) continue;
    e.info.log.push(raw.length > LINE_CAP ? `${raw.slice(0, LINE_CAP)}…` : raw);
    e.lines++;
  }
  if (e.info.log.length > LOG_LINES) e.info.log.splice(0, e.info.log.length - LOG_LINES);
}

const snapshot = (e: Entry): BackgroundInfo => ({ ...e.info, log: [...e.info.log] });

export function listBackground(cwd: string): BackgroundInfo[] {
  const base = path.resolve(cwd);
  return [...entries.values()].filter((e) => e.info.cwd === base).map(snapshot).sort((a, b) => b.startedAt - a.startedAt);
}

export function runningCount(cwd: string): number {
  return listBackground(cwd).filter((i) => i.running).length;
}

/** Start `command` in `cwd` and leave it going. Answers once it has had a moment to print its first lines, or to fail. */
export async function startBackground(cwd: string, command: string, opts: { settleMs?: number } = {}): Promise<BackgroundInfo> {
  const base = path.resolve(cwd);
  const cmd = command.trim();
  if (!cmd) throw new Error("Give a command to run.");
  if (runningCount(base) >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} commands are already running in the background here. Stop one first.`);
  const win = process.platform === "win32";
  const { bin, args } = shellLine(cmd);
  const child = spawn(bin, args, {
    cwd: base,
    env: { ...childEnv(), ...folderVars(base), ...NON_INTERACTIVE, NO_COLOR: "1", FORCE_COLOR: "0" },
    windowsHide: true,
    // Its own process group, so stopping it stops what it started too (a watcher's children, a server's workers).
    detached: !win,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const id = `bg${++counter}`;
  const e: Entry = { info: { id, cwd: base, command: cmd, startedAt: Date.now(), running: true, log: [] }, child, lines: 0 };
  entries.set(key(base, id), e);
  child.stdout?.setEncoding("utf8").on("data", (d: string) => push(e, d));
  child.stderr?.setEncoding("utf8").on("data", (d: string) => push(e, d));
  const ended = new Promise<void>((resolve) => {
    child.once("error", (err) => {
      push(e, `Could not start: ${err.message}`);
      e.info.running = false;
      e.info.exitCode = null;
      e.info.endedAt = Date.now();
      resolve();
    });
    child.once("close", (code) => {
      e.info.running = false;
      e.info.exitCode = code;
      e.info.endedAt = Date.now();
      resolve();
    });
  });
  // Something that fails at once (a typo, a missing script) should say so in the answer, not leave a "running" task that isn't.
  await Promise.race([ended, new Promise<void>((r) => setTimeout(r, opts.settleMs ?? 1500))]);
  return snapshot(e);
}

export function readBackground(cwd: string, id: string, last = 80): BackgroundInfo | null {
  const e = entries.get(key(cwd, id));
  if (!e) return null;
  const snap = snapshot(e);
  snap.log = snap.log.slice(-Math.max(1, Math.min(400, last)));
  return snap;
}

/**
 * Stop a command and everything it started. On Windows that has to happen while the shell is still alive: once it has
 * gone, taskkill has no root to walk the tree from, and the grandchildren keep running. On POSIX the command needs its
 * own process group (`detached`), or there is no group to signal.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    else process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** Stop one, politely and then not. Resolves once it has gone, or after a few seconds if it won't. */
export async function stopBackground(cwd: string, id: string): Promise<BackgroundInfo | null> {
  const e = entries.get(key(cwd, id));
  if (!e) return null;
  if (e.info.running) {
    e.info.stopped = true;
    const gone = new Promise<void>((r) => e.child.once("close", () => r()));
    killTree(e.child, "SIGTERM");
    // Then not politely, and its output closed: on Windows a job Git Bash put in the background (`… &`) is not in the
    // tree taskkill walks, and it would hold the output open, and look like it was running, until it ended by itself.
    // With nothing to write to, it ends the next time it writes. taskkill again only while the shell is still there:
    // once it has exited, its PID may already be another process's.
    const hard = setTimeout(() => {
      if (process.platform !== "win32" || e.child.exitCode === null) killTree(e.child, "SIGKILL");
      e.child.stdout?.destroy();
      e.child.stderr?.destroy();
    }, 3000);
    await Promise.race([gone, new Promise<void>((r) => setTimeout(r, 5000))]);
    clearTimeout(hard);
  }
  return snapshot(e);
}

/** Drop what has finished, so a long session's list is what is still of interest. */
export function forgetFinished(cwd: string): number {
  const base = path.resolve(cwd);
  let n = 0;
  for (const [k, e] of entries) if (e.info.cwd === base && !e.info.running) (entries.delete(k), n++);
  return n;
}

/** Nothing started here outlives the runner. */
export function stopAllBackground(): void {
  for (const e of entries.values()) if (e.info.running) killTree(e.child, "SIGKILL");
}
// On exit only: a signal handler here would change how whatever imports this shuts down.
process.once("exit", stopAllBackground);
