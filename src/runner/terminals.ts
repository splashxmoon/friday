import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { shellEnv } from "./adapters.js";

/**
 * Real shells on a linked machine, for a browser to draw (the Terminal panel, without the desktop app).
 *
 * The desktop app opens its terminals itself (desktop/terminal.ts). A browser can't, so it asks Friday, Friday asks the
 * machine's runner, and the runner opens them here, the same way: a pty, so the prompt redraws, colours work, and
 * something interactive can hold the screen. Each shell belongs to the page connection that opened it (`owner`) and dies
 * with it.
 *
 * The pty module is native. The desktop app ships it beside its runner; a runner downloaded on its own (an always-on
 * machine, a computer connected from a browser) installs it once into ~/.friday-runner with the npm that came with its
 * Node. Where that can't be done, a shell over pipes stands in, with the line editing the pty would otherwise do.
 */

export type TermIn =
  | { op: "start"; owner: string; req: string; id: string; cols?: number; rows?: number; cwd?: string }
  | { op: "write"; owner: string; id: string; data: string }
  | { op: "resize"; owner: string; id: string; cols?: number; rows?: number }
  | { op: "kill"; owner: string; id: string }
  | { op: "drop"; owner: string };
export type TermOut =
  | { kind: "term"; op: "started"; owner: string; req: string; result: { ok: true; shell: string; cwd: string; resumed?: boolean; replay?: string } | { ok: false; error: string } }
  | { kind: "term"; op: "data"; owner: string; id: string; data: string }
  | { kind: "term"; op: "exit"; owner: string; id: string; code: number };

interface Pty {
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(f: (d: string) => void): void;
  onExit(f: (e: { exitCode: number }) => void): void;
}
type PtySpawn = (file: string, args: string[], opts: Record<string, unknown>) => Pty;

interface Shell {
  pty: Pty;
  owner: string;
  cwd: string;
  out: string;
}

/** How much of a shell's output is kept to draw again: a long scrollback, not a whole build log. */
const KEEP = 256_000;
const PTY_PACKAGE = "@homebridge/node-pty-prebuilt-multiarch";
const PTY_VERSION = "0.14.1";
const OWN_MODULES = path.join(homedir(), ".friday-runner");

function usable(dir: string): string | null {
  if (!dir) return null;
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** The shell a person expects on this platform, or the one they configured: the same as the desktop app's. */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.FRIDAY_SHELL || "powershell.exe", args: [] };
  return { file: process.env.FRIDAY_SHELL || process.env.SHELL || "/bin/bash", args: ["-l"] };
}

/** The pty module: beside this runner (the desktop app), installed for it before, or installed now. Null when it can't be. */
let ptyLoad: Promise<PtySpawn | null> | null = null;
function loadPty(say: (text: string) => void): Promise<PtySpawn | null> {
  ptyLoad ??= (async () => {
    const from = (base: string): PtySpawn | null => {
      try {
        return (createRequire(base)(PTY_PACKAGE) as { spawn: PtySpawn }).spawn;
      } catch {
        return null;
      }
    };
    // FRIDAY_PTY_BASE: the desktop app's own runner.mjs, beside the node-pty it ships, when this is a runner it downloaded
    // and keeps in its data folder instead (docs/runner-updates.md).
    const shipped = process.env.FRIDAY_PTY_BASE;
    const here = from(import.meta.url) ?? (shipped ? from(shipped) : null) ?? from(path.join(OWN_MODULES, "package.json"));
    if (here) return here;
    say("\r\nSetting up this machine's terminal (once, about half a minute)…\r\n");
    const ok = await new Promise<boolean>((resolve) => {
      const npm = spawnChild(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", OWN_MODULES, `${PTY_PACKAGE}@${PTY_VERSION}`], {
        stdio: "ignore",
        shell: process.platform === "win32",
        windowsHide: true,
      });
      npm.on("error", () => resolve(false));
      npm.on("close", (code) => resolve(code === 0));
    });
    return ok ? from(path.join(OWN_MODULES, "package.json")) : null;
  })();
  return ptyLoad;
}

/**
 * A shell over pipes, for a machine with no pty: what's typed is echoed and edited here (backspace, Ctrl-C, Ctrl-U) and
 * goes to the shell a line at a time. Full-screen programs won't draw in it; commands and their output do.
 */
function pipeShell(cwd: string): Pty {
  const win = process.platform === "win32";
  const child: ChildProcess = win
    ? spawnChild("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", "-"], { cwd, windowsHide: true })
    : spawnChild(process.env.SHELL || "/bin/sh", ["-i"], { cwd, env: { ...shellEnv(), PS1: "$ " } });
  let line = "";
  let onData: (d: string) => void = () => {};
  const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
  child.stdout?.on("data", (b: Buffer) => onData(crlf(b.toString())));
  child.stderr?.on("data", (b: Buffer) => onData(crlf(b.toString())));
  const prompt = () => win && onData(`PS ${cwd}> `);
  setTimeout(prompt, 50);
  return {
    write(d) {
      for (const ch of d) {
        if (ch === "\r") {
          onData("\r\n");
          child.stdin?.write(`${line}\n`);
          line = "";
          if (win) setTimeout(prompt, 300);
        } else if (ch === "\x7f" || ch === "\b") {
          if (line) (line = line.slice(0, -1)), onData("\b \b");
        } else if (ch === "\x03") {
          line = "";
          onData("^C\r\n");
          prompt();
        } else if (ch === "\x15") {
          onData("\b \b".repeat(line.length));
          line = "";
        } else if (ch >= " ") {
          line += ch;
          onData(ch);
        }
      }
    },
    resize() {},
    kill: () => void child.kill(),
    onData: (f) => void (onData = f),
    onExit: (f) => void child.on("close", (code) => f({ exitCode: code ?? 0 })),
  };
}

export class Terminals {
  private shells = new Map<string, Shell>();

  constructor(private send: (m: TermOut) => void) {}

  handle(m: TermIn): void {
    if (m.op === "start") void this.start(m);
    else if (m.op === "drop") {
      for (const [id, s] of this.shells) if (s.owner === m.owner) this.kill(id);
    } else {
      const s = this.shells.get(m.id);
      if (!s || s.owner !== m.owner) return;
      if (m.op === "write" && typeof m.data === "string") s.pty.write(m.data);
      else if (m.op === "resize") {
        try {
          s.pty.resize(Math.max(20, Number(m.cols) || 80), Math.max(5, Number(m.rows) || 24));
        } catch {
          // The shell exited between the resize and the message.
        }
      } else if (m.op === "kill") this.kill(m.id);
    }
  }

  stopAll(): void {
    for (const id of [...this.shells.keys()]) this.kill(id);
  }

  private kill(id: string): void {
    const s = this.shells.get(id);
    if (!s) return;
    this.shells.delete(id);
    try {
      s.pty.kill();
    } catch {
      // Already gone.
    }
  }

  private async start(m: Extract<TermIn, { op: "start" }>): Promise<void> {
    const reply = (result: Extract<TermOut, { op: "started" }>["result"]) => this.send({ kind: "term", op: "started", owner: m.owner, req: m.req, result });
    if (!m.id) return reply({ ok: false, error: "That terminal has no id." });
    const cwd = usable(m.cwd ?? "") ?? homedir();
    const cols = Math.max(20, Number(m.cols) || 80);
    const rows = Math.max(5, Number(m.rows) || 24);
    const { file, args } = defaultShell();
    // Asking again is not asking for a new shell (the page re-renders, or came back): the same one, and what it printed.
    const running = this.shells.get(m.id);
    if (running && running.owner === m.owner) {
      if (running.cwd === cwd) {
        try {
          running.pty.resize(cols, rows);
        } catch {
          // Nothing to size.
        }
        return reply({ ok: true, shell: path.basename(file), cwd, resumed: true, replay: running.out });
      }
      this.kill(m.id);
    }
    const early: string[] = [];
    const spawn = await loadPty((t) => early.push(t));
    try {
      const pty = spawn
        ? spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env: { ...shellEnv(), TERM: "xterm-256color" }, useConpty: true })
        : pipeShell(cwd);
      const shell: Shell = { pty, owner: m.owner, cwd, out: early.join("") };
      this.shells.set(m.id, shell);
      pty.onData((data) => {
        shell.out = shell.out.length + data.length > KEEP ? (shell.out + data).slice(-KEEP) : shell.out + data;
        this.send({ kind: "term", op: "data", owner: m.owner, id: m.id, data });
      });
      pty.onExit(({ exitCode }) => {
        if (this.shells.get(m.id)?.pty !== pty) return;
        this.shells.delete(m.id);
        this.send({ kind: "term", op: "exit", owner: m.owner, id: m.id, code: exitCode });
      });
      reply({ ok: true, shell: spawn ? path.basename(file) : `${path.basename(file)} (basic)`, cwd, ...(shell.out ? { replay: shell.out } : {}) });
    } catch (err) {
      reply({ ok: false, error: (err as Error).message });
    }
  }
}
