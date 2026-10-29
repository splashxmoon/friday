/**
 * Small native powers both desktop apps share (desktop/main.ts and src/local/desktop.ts): opening a session's folder, or a file
 * in it at a line, in the person's own tools, and the dock's count of what waits on them.
 *
 * "Open in" is what every tool like this has (Conductor, Superset, Emdash, the Codex app): the work is in a folder on this
 * computer, and the editor you already know is one press away. Editors are opened through their own links (vscode://file/…),
 * so a line can go with the path, and only the ones this computer has a handler for are offered. A path is opened only when it
 * is on this computer: a session's folder may be on another machine of yours, and then there is nothing here to open.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { app, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

export type OpenTarget = "vscode" | "cursor" | "windsurf" | "zed" | "files" | "terminal" | "iterm" | "ghostty" | "warp";

/** The editors opened by their own link, with the scheme that names them. */
const EDITORS: { id: OpenTarget; label: string; scheme: string }[] = [
  { id: "vscode", label: "VS Code", scheme: "vscode" },
  { id: "cursor", label: "Cursor", scheme: "cursor" },
  { id: "windsurf", label: "Windsurf", scheme: "windsurf" },
  { id: "zed", label: "Zed", scheme: "zed" },
];

const MAC_TERMINALS: { id: OpenTarget; label: string; app: string }[] = [
  { id: "iterm", label: "iTerm", app: "iTerm" },
  { id: "ghostty", label: "Ghostty", app: "Ghostty" },
  { id: "warp", label: "Warp", app: "Warp" },
];

const macApp = (name: string) => ["/Applications", path.join(app.getPath("home"), "Applications")].some((d) => existsSync(path.join(d, `${name}.app`)));

/** What this computer can open a folder in, in the order the menu lists them. Looked at once: a new editor shows after a restart. */
let targets: { id: OpenTarget; label: string; editor: boolean }[] | null = null;
function openTargets(): { id: OpenTarget; label: string; editor: boolean }[] {
  if (targets) return targets;
  const editors = EDITORS.filter((e) => {
    try {
      return !!app.getApplicationNameForProtocol(`${e.scheme}://`);
    } catch {
      return false;
    }
  }).map((e) => ({ id: e.id, label: e.label, editor: true }));
  const files = { id: "files" as const, label: process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "File Explorer" : "Files", editor: false };
  const terminals =
    process.platform === "darwin"
      ? [{ id: "terminal" as const, label: "Terminal", editor: false }, ...MAC_TERMINALS.filter((t) => macApp(t.app)).map((t) => ({ id: t.id, label: t.label, editor: false }))]
      : [{ id: "terminal" as const, label: "Terminal", editor: false }];
  targets = [...editors, files, ...terminals];
  return targets;
}

/** A bundle is a folder macOS runs rather than opens: those are only ever shown in Finder, never opened. */
const BUNDLE = /\.(app|bundle|framework|pkg|mpkg|prefPane|kext|plugin)\/?$/i;

async function openIn(target: OpenTarget, where: string, line?: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!path.isAbsolute(where) || !existsSync(where)) return { ok: false, error: "That folder isn't on this computer." };
  const dir = statSync(where).isDirectory();
  const editor = EDITORS.find((e) => e.id === target);
  if (editor) {
    const p = where.replace(/\\/g, "/");
    const at = !dir && line && Number.isInteger(line) && line > 0 ? `:${line}` : "";
    await shell.openExternal(`${editor.scheme}://file${p.startsWith("/") ? "" : "/"}${encodeURI(p)}${at}`);
    return { ok: true };
  }
  if (target === "files") {
    if (dir && !BUNDLE.test(where)) {
      const err = await shell.openPath(where);
      return err ? { ok: false, error: err } : { ok: true };
    }
    shell.showItemInFolder(where);
    return { ok: true };
  }
  const cwd = dir ? where : path.dirname(where);
  const run = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
    new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      try {
        const child = spawn(cmd, args, { ...opts, detached: true, stdio: "ignore" });
        child.once("error", (e) => resolve({ ok: false, error: e.message }));
        child.once("spawn", () => (child.unref(), resolve({ ok: true })));
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message });
      }
    });
  if (process.platform === "darwin") {
    if (target === "warp") return run("open", [`warp://action/new_tab?path=${encodeURIComponent(cwd)}`]);
    if (target === "ghostty") return run("open", ["-na", "Ghostty", "--args", `--working-directory=${cwd}`]);
    const mac = MAC_TERMINALS.find((t) => t.id === target);
    return new Promise((resolve) => execFile("open", ["-a", mac?.app ?? "Terminal", cwd], (e) => resolve(e ? { ok: false, error: e.message } : { ok: true })));
  }
  if (process.platform === "win32") {
    const wt = await run("wt.exe", ["-d", cwd]);
    return wt.ok ? wt : run("cmd.exe", ["/c", "start", "cmd.exe"], { cwd });
  }
  const x = await run("x-terminal-emulator", [], { cwd });
  return x.ok ? x : run("gnome-terminal", [`--working-directory=${cwd}`]);
}

/** Answers the page's "Open in" menu and its dock count, for a page `fromApp` says is Friday's own. */
export function registerNative(fromApp: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean): void {
  ipcMain.handle("friday:open-targets", (e) => (fromApp(e) ? openTargets() : []));
  ipcMain.handle("friday:open-in", (e, req: { target?: unknown; path?: unknown; line?: unknown }) => {
    if (!fromApp(e)) return { ok: false, error: "Not from Friday." };
    const target = String(req?.target ?? "") as OpenTarget;
    if (!openTargets().some((t) => t.id === target)) return { ok: false, error: "That isn't on this computer." };
    if (typeof req?.path !== "string" || !req.path) return { ok: false, error: "No folder to open." };
    return openIn(target, req.path, typeof req.line === "number" ? req.line : undefined);
  });
  // A Work session's piece (client/WorkPanels.tsx) in the app this computer opens it with: a deck in Keynote, a video in QuickTime.
  ipcMain.handle("friday:open-file", async (e, file: unknown) => {
    if (!fromApp(e)) return { ok: false, error: "Not from Friday." };
    if (typeof file !== "string" || !path.isAbsolute(file) || !existsSync(file) || statSync(file).isDirectory()) return { ok: false, error: "That file isn't on this computer." };
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true };
  });
  // How many things wait on the person, on the dock icon (macOS) or the launcher's badge (Linux, where it has one); none clears it.
  ipcMain.on("friday:badge", (e, n: unknown) => {
    if (!fromApp(e)) return;
    const count = Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
    try {
      app.setBadgeCount(count);
    } catch {
      // A platform without a badge: the sidebar says it anyway.
    }
  });
}
