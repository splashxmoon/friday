/**
 * Real shells on this computer, for the page to draw.
 *
 * The terminal panel can otherwise only ask an agent to run one command and
 * wait for it. These are ptys: the prompt redraws, colours work, and something
 * interactive can hold the screen. The page draws them — the window shows a
 * Friday that may be hosted, and only the main process can open a shell here.
 *
 * Shells are keyed by an id the page chooses, not by window, because one panel
 * holds several at once. Each belongs to the window that asked for it and dies
 * with it, so a closed window never leaves a shell running.
 */
import { spawn, type IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { shellEnv } from "./runner/adapters.js";

interface Shell {
  pty: IPty;
  cwd: string;
  /** The window that owns it: only that window may drive or be told about it. */
  windowId: number;
  /** What it has printed lately, for a page that comes back to it (a reload, the panel opened again) to draw. */
  out: string;
}

/** How much of a shell's output is kept to draw again: a long scrollback, not a whole build log. */
const KEEP = 256_000;

const shells = new Map<string, Shell>();

/** A directory the shell can actually start in, or nothing. */
function usable(dir: string): string | null {
  if (!dir) return null;
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** The shell a person expects on this platform, or the one they configured. */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.FRIDAY_SHELL || "powershell.exe", args: [] };
  const file = process.env.FRIDAY_SHELL || process.env.SHELL || "/bin/bash";
  // A login shell, so the PATH is the one the person's own terminal has —
  // which is where nvm, homebrew and every coding CLI actually live.
  return { file, args: ["-l"] };
}

/** Only the window that owns a shell may touch it. */
function mine(e: IpcMainEvent | IpcMainInvokeEvent, id: unknown): Shell | undefined {
  const w = BrowserWindow.fromWebContents(e.sender);
  const shell = typeof id === "string" ? shells.get(id) : undefined;
  return w && shell?.windowId === w.id ? shell : undefined;
}

function killShell(id: string): void {
  const shell = shells.get(id);
  if (!shell) return;
  shells.delete(id);
  try {
    shell.pty.kill();
  } catch {
    // Already gone; the map entry was all that was left of it.
  }
}

/** A window's shells die with the window, rather than outliving the page that asked. */
function bindToWindow(w: BrowserWindow): void {
  if (w.listenerCount("closed")) return;
  w.on("closed", () => {
    for (const [id, shell] of shells) if (shell.windowId === w.id) killShell(id);
  });
}

/** `fromApp`: whether a request comes from Friday's own page (main.ts), never another site the window was sent to. */
export function registerTerminal(fromApp: (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean = () => false): void {
  ipcMain.handle("friday:pty-start", (e, opts: { id?: unknown; cols?: unknown; rows?: unknown; cwd?: unknown }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || !fromApp(e)) return { ok: false as const, error: "No window." };
    const id = String(opts?.id ?? "");
    if (!id) return { ok: false as const, error: "That terminal has no id." };
    const { file, args } = defaultShell();
    // The session's folder may be on somebody else's machine, or simply gone.
    // Windows answers a bad working directory with "Cannot create process,
    // error code: 267", which tells the person nothing they can act on.
    const cwd = usable(typeof opts?.cwd === "string" ? opts.cwd : "") ?? homedir();
    const cols = Math.max(20, Number(opts?.cols) || 80);
    const rows = Math.max(5, Number(opts?.rows) || 24);

    // Asking again is not asking for a new shell. The page re-renders for its
    // own reasons, and killing the shell each time took the session with it —
    // it also fired the old shell's exit into the new one's screen, which is
    // how a terminal ends up saying it exited and then printing two banners.
    const running = shells.get(id);
    if (running && running.windowId === w.id) {
      if (running.cwd === cwd) {
        try {
          running.pty.resize(cols, rows);
        } catch {
          // Nothing to size; the screen is still the one it wrote to.
        }
        return { ok: true as const, shell: path.basename(file), cwd: running.cwd, resumed: true, replay: running.out };
      }
      // A different folder is a different shell, deliberately.
      killShell(id);
    }

    try {
      const pty = spawn(file, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        // Without a host Claude Code session's markers (shellEnv): a tool started here is the person's own, as in their terminal.
        env: { ...shellEnv(), TERM: "xterm-256color" },
        // Electron's process has no console of its own, and the old winpty
        // backend wants one — it fails with "AttachConsole failed" and the
        // terminal comes up blank. ConPTY is Windows' own and needs none.
        useConpty: true,
      });
      const shell: Shell = { pty, cwd, windowId: w.id, out: "" };
      shells.set(id, shell);
      bindToWindow(w);
      pty.onData((data) => {
        shell.out = shell.out.length + data.length > KEEP ? (shell.out + data).slice(-KEEP) : shell.out + data;
        if (!w.isDestroyed()) w.webContents.send("friday:pty-data", id, data);
      });
      pty.onExit(({ exitCode }) => {
        // Only if it is still this id's shell: one we replaced on purpose has
        // no business announcing itself into its successor's screen.
        if (shells.get(id)?.pty !== pty) return;
        shells.delete(id);
        if (!w.isDestroyed()) w.webContents.send("friday:pty-exit", id, exitCode);
      });
      return { ok: true as const, shell: path.basename(file), cwd };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  // Typing into, sizing and closing a shell are checked too: a shell outlives a page, so a page that isn't Friday's must not
  // reach one Friday's page opened (Security AUDIT RUN-1).
  ipcMain.on("friday:pty-write", (e, id: unknown, data: unknown) => {
    if (typeof data === "string" && fromApp(e)) mine(e, id)?.pty.write(data);
  });

  ipcMain.on("friday:pty-resize", (e, id: unknown, size: { cols?: unknown; rows?: unknown }) => {
    const shell = fromApp(e) ? mine(e, id) : undefined;
    if (!shell) return;
    try {
      shell.pty.resize(Math.max(20, Number(size?.cols) || 80), Math.max(5, Number(size?.rows) || 24));
    } catch {
      // The shell exited between the resize and the message; nothing to size.
    }
  });

  ipcMain.on("friday:pty-kill", (e, id: unknown) => {
    if (fromApp(e) && mine(e, id)) killShell(String(id));
  });
}

/** Every shell dies with the app, rather than outliving the window that opened it. */
export function stopTerminals(): void {
  for (const id of [...shells.keys()]) killShell(id);
}
