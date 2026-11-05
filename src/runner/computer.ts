import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { MeshAnswer } from "./friday-mcp.js";

/**
 * Computer use for every agent and crew teammate, on macOS, Windows and Linux (Arun, 2026-11-05: "lets look into allowing computer
 * use for the agents and crew too … make this work for mac, weindows and linux"). Claude Code's own computer use is macOS-only
 * and only in an interactive session, which Friday's runs aren't; Codex's comes with the ChatGPT app on macOS. So Friday has its
 * own: one `computer` tool on the friday MCP server every tool already has (agent-mesh.ts COMPUTER_TOOL), the server checking the
 * ask is the computer's owner's own work, and this runner, on the computer itself, doing it:
 *
 * - The screen: drawn by the desktop app (desktopCapturer, desktop/screen.ts), which works on all three and keeps Friday's own
 *   "using your computer" bar out of the picture; without the app, the system's own (screencapture, PowerShell, grim/import/scrot).
 * - The mouse and keys: the system's own, no native module to build: CoreGraphics events through osascript on macOS, user32's
 *   SendInput through one PowerShell kept open on Windows, xdotool on Linux under X (ydotool under Wayland).
 * - Off on a computer until its owner turns it on (Settings › Computer, here in the state folder); then asked once a session, in
 *   the feed (runner.ts computerTurn); a bar on the screen while an agent uses it, with Stop.
 *
 * Coordinates are the last screenshot's pixels, as the agent saw them; the picture is at most MAX_W wide, so a big screen costs
 * no more to look at than a laptop's.
 */

export type ComputerAction = "screenshot" | "click" | "double_click" | "right_click" | "move" | "drag" | "scroll" | "type" | "key" | "wait";
export const COMPUTER_ACTIONS: ComputerAction[] = ["screenshot", "click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "wait"];

/** One action, as the server checked it (agent-mesh.ts computerAsk). */
export interface ComputerAct {
  action: ComputerAction;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  text?: string;
  keys?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  seconds?: number;
}

/** The widest a screenshot is sent: a model reads no more than this, and a 5K screen at full size is five times the tokens. */
export const MAX_W = 1280;

// ── whether it's on, on this computer ───────────────────────────────────────────────────────────────────────────────────────

const stateDir = () => process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday");
const settingFile = () => path.join(stateDir(), "computer-use.json");

/** Whether agents may use this computer's screen, mouse and keyboard: its owner's choice, off until made. */
export async function computerUseOn(): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(settingFile(), "utf8")) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

export async function setComputerUse(on: boolean): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(settingFile(), JSON.stringify({ on, at: Date.now() }, null, 2));
}

// ── the screen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A screenshot, and where it sits in the coordinates the mouse is moved in (points on macOS, logical pixels elsewhere). */
export interface Screen {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/** A point in the last screenshot, in the mouse's coordinates: scaled up from the picture, kept on the screen. */
export function toScreen(s: Pick<Screen, "width" | "height" | "bounds">, x: number, y: number): { x: number; y: number } {
  const cx = Math.min(s.width - 1, Math.max(0, x));
  const cy = Math.min(s.height - 1, Math.max(0, y));
  return { x: Math.round(s.bounds.x + (cx * s.bounds.width) / s.width), y: Math.round(s.bounds.y + (cy * s.bounds.height) / s.height) };
}

/** The size a screen's picture is sent at: at most MAX_W wide, its shape kept. */
export function shotSize(w: number, h: number): { width: number; height: number } {
  const k = Math.min(1, MAX_W / w);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** The desktop app draws the screen when it started this runner and says it can (desktop-screen.ts, over the channel). */
const viaDesktop = () => process.env.FRIDAY_SCREEN === "1" && typeof process.send === "function";

/** The desktop app's side, when this runner runs in its own process (the open-source app): asked directly, no channel. */
export interface ScreenDriver {
  capture(maxWidth: number): Promise<Record<string, unknown>>;
  using(key: string, name: string | null): void;
  /** The agent's mouse is about to act, or has: the bar lets clicks through meanwhile, so it never takes one meant for the
   *  window under it (the agent can't see it: it's kept out of its screenshots). */
  acting?(on: boolean): void;
  status(): Promise<Record<string, unknown>>;
  allow(): Promise<Record<string, unknown>>;
  onStop(fn: (key: string) => void): void;
}
let driver: ScreenDriver | null = null;
export function setScreenDriver(d: ScreenDriver | null): void {
  driver = d;
}
/** Whether the desktop app is here to ask, either way. */
const hasDesktop = () => !!driver || viaDesktop();
/** One ask of the desktop app, whichever way it is reached. */
function desk(kind: "screen.capture" | "screen.status" | "screen.allow", body: Record<string, unknown>, ms?: number): Promise<Record<string, unknown>> {
  if (driver) return kind === "screen.capture" ? driver.capture(Number(body.maxWidth) || MAX_W) : kind === "screen.status" ? driver.status() : driver.allow();
  return desktopAsk(kind, body, ms);
}

const asks = new Map<string, (m: Record<string, unknown>) => void>();
let listening = false;
function desktopAsk(kind: string, body: Record<string, unknown>, ms = 15_000): Promise<Record<string, unknown>> {
  if (!listening) {
    listening = true;
    process.on("message", (m: unknown) => {
      const d = m as { kind?: string; id?: string } | null;
      if (d?.kind === "screen.done" && typeof d.id === "string") asks.get(d.id)?.(d as Record<string, unknown>);
    });
    process.channel?.unref();
  }
  return new Promise((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => (asks.delete(id), resolve({ error: "The desktop app didn't answer." })), ms);
    asks.set(id, (m) => (clearTimeout(timer), asks.delete(id), resolve(m)));
    process.send!({ kind, id, ...body });
  });
}

/** Tells the desktop app an agent is using the computer, or has stopped: its bar on the screen (desktop/screen.ts). `lane`: the
 * runner's own key for it, its session and lane, as Stop names it back. */
export function sayUsing(lane: string, name: string | null): void {
  if (driver) driver.using(lane, name);
  else if (viaDesktop()) process.send!({ kind: "screen.using", lane, name });
}

/** The bar lets clicks through while the agent's mouse acts (ScreenDriver.acting). */
function sayActing(on: boolean): void {
  if (driver) driver.acting?.(on);
  else if (viaDesktop()) process.send!({ kind: "screen.acting", on });
}

/** Whether a computer can be used here as the person was promised: the desktop app is here, to show the bar with Stop. */
export const canShowBar = () => hasDesktop() || !!fake();

/** Stops asked for from the desktop app's bar, by lane. */
export function onStopAsked(fn: (lane: string) => void): void {
  if (driver) return driver.onStop(fn);
  if (!viaDesktop()) return;
  process.on("message", (m: unknown) => {
    const d = m as { kind?: string; lane?: unknown } | null;
    if (d?.kind === "screen.stop" && typeof d.lane === "string") fn(d.lane);
  });
}

/**
 * Tests only (e2e/local.ts): FRIDAY_COMPUTER_FAKE names a file the steps are written to instead of done, and the screen is a
 * picture of nothing, so a run of the suite never moves the mouse of the computer it runs on.
 */
const fake = () => process.env.FRIDAY_COMPUTER_FAKE || "";
const BLANK = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export async function screenshot(): Promise<Screen | { error: string }> {
  if (fake()) return { data: BLANK, mimeType: "image/png", width: 1280, height: 800, bounds: { x: 0, y: 0, width: 2560, height: 1600 } };
  if (hasDesktop()) {
    const r = await desk("screen.capture", { maxWidth: MAX_W });
    if (typeof r.data === "string") return r as unknown as Screen;
    // Not drawn there (an older app, or the system said no): the system's own, which says better what it needs.
    if (process.platform !== "darwin" || !/Screen Recording/.test(String(r.error ?? ""))) {
      const own = await nativeShot().catch((e: Error) => ({ error: e.message }));
      return "data" in own ? own : { error: String(r.error ?? own.error) };
    }
    return { error: String(r.error) };
  }
  return nativeShot().catch((e: Error) => ({ error: e.message }));
}

function run(cmd: string, args: string[], opts: { input?: string; timeout?: number; signal?: AbortSignal } = {}): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => c.kill(), opts.timeout ?? 20_000);
    // Stopped (the bar's Stop, the turn interrupted): what it was doing stops with it, not after.
    const stop = () => c.kill();
    opts.signal?.addEventListener("abort", stop, { once: true });
    c.on("close", () => opts.signal?.removeEventListener("abort", stop));
    c.stdout.on("data", (d: Buffer) => out.push(d));
    c.stderr.on("data", (d: Buffer) => (err += d.toString()));
    c.on("error", (e) => (clearTimeout(timer), reject(e)));
    c.on("close", (code) => (clearTimeout(timer), resolve({ code: code ?? 1, out: Buffer.concat(out), err })));
    if (opts.input !== undefined) c.stdin.end(opts.input);
    else c.stdin.end();
  });
}

/** A PowerShell script as a file of its own, run with -File: passed on its command line, its quotes were PowerShell's to mangle. */
async function psFile(name: string, script: string): Promise<string> {
  const dir = path.join(tmpdir(), "friday-computer");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}-${process.pid}.ps1`);
  // With a byte-order mark, so Windows PowerShell reads it as UTF-8.
  await writeFile(file, "\ufeff" + script);
  return file;
}

/** The system's own screenshot, scaled to MAX_W, when there's no desktop app to draw it. */
async function nativeShot(): Promise<Screen> {
  const dir = path.join(tmpdir(), `friday-screen-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.png`);
  try {
    if (process.platform === "darwin") {
      const r = await run("screencapture", ["-x", "-m", "-t", "png", file]);
      if (r.code !== 0) throw new Error(`screencapture: ${r.err.trim() || r.code}. Allow Friday under System Settings › Privacy & Security › Screen Recording.`);
      const b = await macBounds();
      // Its pixels, not its points: a Retina screen 1,280 points wide is 2,560 pixels.
      if ((await pngSize(file)).width > MAX_W) await run("sips", ["--resampleWidth", String(MAX_W), file]);
      const px = await pngSize(file);
      return { data: (await readFile(file)).toString("base64"), mimeType: "image/png", width: px.width, height: px.height, bounds: b };
    }
    if (process.platform === "win32") {
      const script = await psFile("screen", winShotScript(file, MAX_W));
      const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
      const m = /^(-?\d+) (-?\d+) (\d+) (\d+)/m.exec(r.out.toString());
      if (r.code !== 0 || !m) throw new Error(`The screen couldn't be captured: ${r.err.trim() || r.out.toString().trim() || r.code}`);
      const px = await pngSize(file);
      return { data: (await readFile(file)).toString("base64"), mimeType: "image/png", width: px.width, height: px.height, bounds: { x: +m[1]!, y: +m[2]!, width: +m[3]!, height: +m[4]! } };
    }
    // Linux: whichever of the usual tools is here, Wayland's grim first when it is Wayland.
    const wayland = process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;
    const tries: [string, string[]][] = [
      ...(wayland ? [["grim", [file]] as [string, string[]]] : []),
      ["import", ["-window", "root", file]],
      ["scrot", ["-o", file]],
      ["gnome-screenshot", ["-f", file]],
      ["spectacle", ["-b", "-n", "-o", file]],
    ];
    let shot = false;
    const missing: string[] = [];
    for (const [cmd, args] of tries) {
      const r = await run(cmd, args).catch(() => null);
      if (r && r.code === 0) {
        shot = true;
        break;
      }
      missing.push(cmd);
    }
    if (!shot) throw new Error(`No screenshot tool here: install one of ${missing.join(", ")} (for example \`sudo apt install imagemagick xdotool\`).`);
    const full = await pngSize(file);
    let bounds = { x: 0, y: 0, width: full.width, height: full.height };
    // The mouse moves in X's pixels, the picture's own size.
    if (full.width > MAX_W) {
      const s = shotSize(full.width, full.height);
      const r = await run("convert", [file, "-resize", `${s.width}x${s.height}`, file]).catch(() => null);
      if (!r || r.code !== 0) bounds = { x: 0, y: 0, width: full.width, height: full.height };
    }
    const px = await pngSize(file);
    return { data: (await readFile(file)).toString("base64"), mimeType: "image/png", width: px.width, height: px.height, bounds };
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

/** A PNG's size, from its header. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const b = await readFile(file);
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) throw new Error("The screenshot isn't a PNG.");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

async function macBounds(): Promise<Screen["bounds"]> {
  const r = await run("osascript", ["-l", "JavaScript", "-e", "ObjC.import('AppKit'); const f = $.NSScreen.screens.objectAtIndex(0).frame; JSON.stringify({ x: 0, y: 0, width: f.size.width, height: f.size.height })"]);
  return JSON.parse(r.out.toString().trim()) as Screen["bounds"];
}

/** Windows: the primary screen, at most `max` wide, to `file`; prints its bounds in the mouse's coordinates. */
export function winShotScript(file: string, max: number): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    // Physical pixels, as the input's PowerShell sees them (WIN_SCRIPT).
    "Add-Type -Name Dpi -Namespace Friday -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'",
    "[void][Friday.Dpi]::SetProcessDPIAware()",
    "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
    "$g = [System.Drawing.Graphics]::FromImage($full)",
    "$g.CopyFromScreen($b.X, $b.Y, 0, 0, $full.Size)",
    `$k = [Math]::Min(1.0, ${max} / $b.Width)`,
    "$w = [int][Math]::Round($b.Width * $k); $h = [int][Math]::Round($b.Height * $k)",
    "$out = New-Object System.Drawing.Bitmap $full, $w, $h",
    `$out.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    'Write-Output ("{0} {1} {2} {3}" -f $b.X, $b.Y, $b.Width, $b.Height)',
  ].join("\n");
}

// ── the mouse and keys ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a backend does, in the mouse's coordinates: the actions taken apart. */
export type Op =
  | { t: "move"; x: number; y: number }
  | { t: "down"; b: "left" | "right" }
  | { t: "up"; b: "left" | "right" }
  | { t: "click"; b: "left" | "right"; n: number }
  | { t: "scroll"; dx: number; dy: number }
  | { t: "key"; key: string; mods: Mod[] }
  | { t: "text"; s: string }
  | { t: "pause"; ms: number };

export type Mod = "cmd" | "ctrl" | "alt" | "shift" | "win";

/**
 * "cmd+shift+t", "ctrl+c", "enter", "alt+tab" as a key and its modifiers. cmd on Windows and Linux is ctrl, as an agent used to a Mac
 * means it; win (super, meta) is the Windows or super key, and on a Mac command.
 */
export function parseKeys(keys: string, platform: NodeJS.Platform = process.platform): { key: string; mods: Mod[] } | null {
  const parts = keys
    .toLowerCase()
    .split(/\s*\+\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const mods: Mod[] = [];
  let key = "";
  for (const p of parts) {
    const m: Mod | null = /^(cmd|command|⌘)$/.test(p)
      ? platform === "darwin"
        ? "cmd"
        : "ctrl"
      : /^(ctrl|control|ctl|⌃)$/.test(p)
        ? "ctrl"
        : /^(alt|option|opt|⌥)$/.test(p)
          ? "alt"
          : /^(shift|⇧)$/.test(p)
            ? "shift"
            : /^(win|windows|super|meta)$/.test(p)
              ? platform === "darwin"
                ? "cmd"
                : "win"
              : null;
    if (m) {
      if (!mods.includes(m)) mods.push(m);
    } else if (key) return null;
    // Two keys that aren't modifiers ("hyper+x"): one wasn't a modifier Friday knows, and pressing the other alone isn't what was asked.
    else key = p;
  }
  key = KEY_ALIAS[key] ?? key;
  if (!key) return null;
  if (!(key in MAC_KEYS) && !/^f([1-9]|1[0-2])$/.test(key)) return null;
  return { key, mods };
}

const KEY_ALIAS: Record<string, string> = { return: "enter", esc: "escape", del: "delete", forwarddelete: "delete", bksp: "backspace", "page_up": "pageup", "page_down": "pagedown", pgup: "pageup", pgdn: "pagedown", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", spacebar: "space" };

/** macOS virtual key codes (Carbon kVK_*), by name. */
export const MAC_KEYS: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, enter: 36, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46, ".": 47, tab: 48, space: 49, "`": 50, backspace: 51, escape: 53,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111, home: 115, pageup: 116, delete: 117, end: 119, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
};

/** Windows virtual-key codes, by name. */
export function winVk(key: string): number | null {
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  const f = /^f([1-9]|1[0-2])$/.exec(key);
  if (f) return 0x6f + Number(f[1]);
  const t: Record<string, number> = { enter: 0x0d, tab: 0x09, escape: 0x1b, backspace: 0x08, delete: 0x2e, space: 0x20, left: 0x25, up: 0x26, right: 0x27, down: 0x28, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, ";": 0xba, "=": 0xbb, ",": 0xbc, "-": 0xbd, ".": 0xbe, "/": 0xbf, "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde };
  return t[key] ?? null;
}
const WIN_MOD: Record<Mod, number> = { ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, cmd: 0x11 };

/** xdotool's key names. */
export function xKey(key: string): string {
  const t: Record<string, string> = { enter: "Return", tab: "Tab", escape: "Escape", backspace: "BackSpace", delete: "Delete", space: "space", left: "Left", up: "Up", right: "Right", down: "Down", home: "Home", end: "End", pageup: "Prior", pagedown: "Next", ";": "semicolon", "=": "equal", ",": "comma", "-": "minus", ".": "period", "/": "slash", "`": "grave", "[": "bracketleft", "\\": "backslash", "]": "bracketright", "'": "apostrophe" };
  return t[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key);
}
const X_MOD: Record<Mod, string> = { ctrl: "ctrl", alt: "alt", shift: "shift", win: "super", cmd: "ctrl" };

/** Linux input event codes, for ydotool under Wayland. */
const EVDEV: Record<string, number> = {
  escape: 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11, "-": 12, "=": 13, backspace: 14, tab: 15, q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, "[": 26, "]": 27, enter: 28, a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, ";": 39, "'": 40, "`": 41, "\\": 43, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, ",": 51, ".": 52, "/": 53, space: 57,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88, home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109, delete: 111,
};
const EVDEV_MOD: Record<Mod, number> = { ctrl: 29, shift: 42, alt: 56, win: 125, cmd: 29 };

/** An action as the backends' steps, given where the last screenshot puts its points. */
export function opsFor(a: ComputerAct, at: (x: number, y: number) => { x: number; y: number }, platform: NodeJS.Platform = process.platform): Op[] | string {
  const point = () => (typeof a.x === "number" && typeof a.y === "number" ? at(a.x, a.y) : null);
  switch (a.action) {
    case "move":
    case "click":
    case "double_click":
    case "right_click": {
      const p = point();
      if (!p) return `${a.action} needs x and y, in the last screenshot's pixels.`;
      const ops: Op[] = [{ t: "move", ...p }];
      if (a.action === "click") ops.push({ t: "click", b: "left", n: 1 });
      if (a.action === "double_click") ops.push({ t: "click", b: "left", n: 2 });
      if (a.action === "right_click") ops.push({ t: "click", b: "right", n: 1 });
      return ops;
    }
    case "drag": {
      const p = point();
      if (!p || typeof a.to_x !== "number" || typeof a.to_y !== "number") return "drag needs x, y (where it starts) and to_x, to_y (where it ends).";
      const q = at(a.to_x, a.to_y);
      const steps: Op[] = [];
      for (let i = 1; i <= 8; i++) steps.push({ t: "move", x: Math.round(p.x + ((q.x - p.x) * i) / 8), y: Math.round(p.y + ((q.y - p.y) * i) / 8) }, { t: "pause", ms: 15 });
      return [{ t: "move", ...p }, { t: "down", b: "left" }, { t: "pause", ms: 60 }, ...steps, { t: "pause", ms: 60 }, { t: "up", b: "left" }];
    }
    case "scroll": {
      const n = Math.max(1, Math.min(30, Math.round(a.amount ?? 5)));
      const d = a.direction ?? "down";
      const p = point();
      return [...(p ? [{ t: "move", ...p } as Op] : []), { t: "scroll", dx: d === "left" ? -n : d === "right" ? n : 0, dy: d === "up" ? n : d === "down" ? -n : 0 }];
    }
    case "type":
      if (!a.text) return "type needs text.";
      return [{ t: "text", s: a.text.slice(0, 4000) }];
    case "key": {
      const k = parseKeys(a.keys ?? "", platform);
      if (!k) return `"${a.keys ?? ""}" isn't a key Friday knows: a letter, digit or punctuation, enter, tab, escape, backspace, delete, space, the arrows, home, end, pageup, pagedown or f1 to f12, with cmd, ctrl, alt and shift, as "cmd+shift+t".`;
      return [{ t: "key", ...k }];
    }
    case "wait":
      return [{ t: "pause", ms: Math.round(Math.max(0.1, Math.min(10, a.seconds ?? 1)) * 1000) }];
    case "screenshot":
      return [];
  }
}

/** macOS: the steps as one osascript run, in CoreGraphics events (Accessibility needed, asked of Friday). */
export const MAC_SCRIPT = `ObjC.import('CoreGraphics'); ObjC.import('AppKit');
function run(argv) {
  const ops = JSON.parse(argv[0]);
  const post = (e) => $.CGEventPost(0, e);
  // Where the pointer is, kept here: the system says where it was a moment ago until the move just posted has gone through, so
  // a click read from it landed where the mouse had been.
  const at0 = $.CGEventGetLocation($.CGEventCreate(null));
  let pos = $.CGPointMake(at0.x, at0.y);
  const here = () => pos;
  let held = null;
  const FLAG = { cmd: 0x100000, ctrl: 0x40000, alt: 0x80000, shift: 0x20000 };
  const flags = (mods) => mods.reduce((f, m) => f | (FLAG[m] || 0), 0);
  const MODKEY = { cmd: 55, shift: 56, alt: 58, ctrl: 59 };
  // A key with its modifiers pressed around it, as a keyboard sends them: apps read the modifier keys, not only the flags.
  const press = (code, mods) => {
    let f = 0;
    for (const m of mods) { f |= FLAG[m] || 0; const e = $.CGEventCreateKeyboardEvent(null, MODKEY[m], true); $.CGEventSetFlags(e, f); post(e); }
    const d = $.CGEventCreateKeyboardEvent(null, code, true); $.CGEventSetFlags(d, f); post(d);
    const u = $.CGEventCreateKeyboardEvent(null, code, false); $.CGEventSetFlags(u, f); post(u);
    for (const m of mods.slice().reverse()) { f &= ~(FLAG[m] || 0); const e = $.CGEventCreateKeyboardEvent(null, MODKEY[m], false); $.CGEventSetFlags(e, f); post(e); }
    delay(0.02);
  };
  for (const o of ops) {
    if (o.t === 'pause') { delay(o.ms / 1000); continue; }
    if (o.t === 'move') { pos = $.CGPointMake(o.x, o.y); post($.CGEventCreateMouseEvent(null, held === 'left' ? 6 : held === 'right' ? 7 : 5, pos, held === 'right' ? 1 : 0)); delay(0.03); continue; }
    if (o.t === 'down' || o.t === 'up') {
      const right = o.b === 'right';
      post($.CGEventCreateMouseEvent(null, right ? (o.t === 'down' ? 3 : 4) : (o.t === 'down' ? 1 : 2), here(), right ? 1 : 0));
      held = o.t === 'down' ? o.b : null; continue;
    }
    if (o.t === 'click') {
      const right = o.b === 'right'; const p = here();
      for (let i = 1; i <= o.n; i++) {
        const d = $.CGEventCreateMouseEvent(null, right ? 3 : 1, p, right ? 1 : 0); $.CGEventSetIntegerValueField(d, 1, i); post(d);
        const u = $.CGEventCreateMouseEvent(null, right ? 4 : 2, p, right ? 1 : 0); $.CGEventSetIntegerValueField(u, 1, i); post(u);
        delay(0.04);
      }
      continue;
    }
    if (o.t === 'scroll') { post($.CGEventCreateScrollWheelEvent2(null, 1, 2, o.dy, o.dx, 0)); continue; }
    if (o.t === 'key') { press(o.code, o.mods); continue; }
    if (o.t === 'text') {
      // Pasted: a keyboard event can't carry text from here (osascript can't hand CoreGraphics the characters), and pasting
      // types any language and symbol as it is. What was on the clipboard is put back after.
      const pb = $.NSPasteboard.generalPasteboard;
      const was = pb.stringForType($.NSPasteboardTypeString);
      pb.clearContents;
      pb.setStringForType($(o.s), $.NSPasteboardTypeString);
      press(9, ['cmd']);
      delay(0.3);
      pb.clearContents;
      if (was && !was.isNil()) pb.setStringForType(was, $.NSPasteboardTypeString);
    }
  }
  return 'ok';
}`;

/** Windows: one PowerShell kept open, reading a line of steps at a time and answering "ok" or what went wrong. */
export const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class FridayInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Mouse(uint flags, int data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  public static void Key(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? 2u : 0u; SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  // Every character of a piece as one SendInput: one call a character (and a sleep between) took a minute for a page of text.
  public static void Text(string s) { var a = new INPUT[s.Length * 2]; for (int k = 0; k < s.Length; k++) { for (int u = 0; u < 2; u++) { var i = new INPUT(); i.type = 1; i.u.ki.wScan = s[k]; i.u.ki.dwFlags = 4u | (u == 1 ? 2u : 0u); a[k * 2 + u] = i; } } SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
}
"@
# Physical pixels, as the screenshot's bounds are: a scaled display put every click off by its scale otherwise.
[void][FridayInput]::SetProcessDPIAware()
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    foreach ($o in (ConvertFrom-Json $line)) {
      switch ($o.t) {
        'pause' { Start-Sleep -Milliseconds $o.ms }
        'move' { [void][FridayInput]::SetCursorPos($o.x, $o.y) }
        'down' { if ($o.b -eq 'right') { [FridayInput]::Mouse(8, 0) } else { [FridayInput]::Mouse(2, 0) } }
        'up' { if ($o.b -eq 'right') { [FridayInput]::Mouse(16, 0) } else { [FridayInput]::Mouse(4, 0) } }
        'click' { for ($i = 0; $i -lt $o.n; $i++) { if ($o.b -eq 'right') { [FridayInput]::Mouse(8, 0); [FridayInput]::Mouse(16, 0) } else { [FridayInput]::Mouse(2, 0); [FridayInput]::Mouse(4, 0) }; Start-Sleep -Milliseconds 40 } }
        'scroll' { if ($o.dy -ne 0) { [FridayInput]::Mouse(0x0800, 120 * $o.dy) }; if ($o.dx -ne 0) { [FridayInput]::Mouse(0x1000, 120 * $o.dx) } }
        'key' { foreach ($m in $o.mods) { [FridayInput]::Key([uint16]$m, $false) }; [FridayInput]::Key([uint16]$o.vk, $false); [FridayInput]::Key([uint16]$o.vk, $true); [array]::Reverse($o.mods); foreach ($m in $o.mods) { [FridayInput]::Key([uint16]$m, $true) } }
        'text' { for ($i = 0; $i -lt $o.s.Length; $i += 64) { [FridayInput]::Text($o.s.Substring($i, [Math]::Min(64, $o.s.Length - $i))); Start-Sleep -Milliseconds 10 } }
      }
    }
    [Console]::Out.WriteLine('ok')
  } catch { [Console]::Out.WriteLine('err ' + $_.Exception.Message) }
}
`;

type WinShell = { p: ChildProcessWithoutNullStreams; ready: Promise<void>; queue: ((line: string) => void)[] };
let win: WinShell | null = null;
let winStarting: Promise<WinShell> | null = null;
function winShell(): Promise<WinShell> {
  if (win && win.p.exitCode === null && !win.p.killed) return Promise.resolve(win);
  // Asked twice before the first was up: one PowerShell, not two (the spare's exit took the other's place away).
  winStarting ??= startWinShell().finally(() => (winStarting = null));
  return winStarting;
}
async function startWinShell(): Promise<WinShell> {
  const script = await psFile("input", WIN_SCRIPT);
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true });
  const queue: ((line: string) => void)[] = [];
  let buf = "";
  let readyOk: () => void = () => {};
  const ready = new Promise<void>((r) => (readyOk = r));
  p.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === "ready") readyOk();
      else if (line) queue.shift()?.(line);
    }
  });
  p.on("exit", () => {
    for (const q of queue.splice(0)) q("err PowerShell stopped");
    if (win?.p === p) win = null;
  });
  win = { p, ready, queue };
  return win;
}

/** JSON with every character past ASCII written as \\uXXXX, which any reader decodes the same. */
export const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The steps, done on this computer. Null when they went; else what went wrong, for the agent. */
export async function perform(ops: Op[], platform: NodeJS.Platform = process.platform, signal?: AbortSignal): Promise<string | null> {
  if (!ops.length) return null;
  if (signal?.aborted) return "Stopped.";
  if (fake()) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(fake(), JSON.stringify(ops) + "\n");
    return null;
  }
  if (platform === "darwin") {
    const mac = ops.map((o) => (o.t === "key" ? { ...o, code: MAC_KEYS[o.key] } : o));
    const r = await run("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT, JSON.stringify(mac)], { timeout: 60_000, signal });
    if (signal?.aborted) return "Stopped.";
    if (r.code !== 0) return `macOS didn't take it: ${r.err.trim() || r.code}. Allow Friday under System Settings › Privacy & Security › Accessibility.`;
    return null;
  }
  if (platform === "win32") {
    const steps = ops.map((o) => (o.t === "key" ? { t: "key", vk: winVk(o.key), mods: o.mods.map((m) => WIN_MOD[m]) } : o));
    const w = await winShell();
    await Promise.race([w.ready, new Promise((r) => setTimeout(r, 20_000))]);
    const line = await new Promise<string>((resolve) => {
      // Long enough for what it was given: its pauses, and its text at about a millisecond a character.
      const ms = 30_000 + ops.reduce((t, o) => t + (o.t === "pause" ? o.ms : o.t === "text" ? o.s.length : 0), 0);
      const timer = setTimeout(() => done("err PowerShell didn't answer"), ms);
      // Stopped: the PowerShell goes, and what it was typing with it; the next action starts another.
      const stop = () => (w.p.kill(), done("err Stopped."));
      signal?.addEventListener("abort", stop, { once: true });
      function done(l: string) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        const i = w.queue.indexOf(done);
        if (i >= 0) w.queue.splice(i, 1);
        resolve(l);
      }
      w.queue.push(done);
      // Plain ASCII on the line, every other character as \\u: PowerShell reads its input in the console's old code page.
      w.p.stdin.write(asciiJson(steps) + "\n");
    });
    return line === "ok" ? null : line.replace(/^err /, "Windows didn't take it: ");
  }
  return linuxPerform(ops, signal);
}

/** A Wayland desktop (GNOME, KDE and most new ones), where DISPLAY is often set too, for XWayland's windows only. */
const waylandSession = () => process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY;
/** ydotool's daemon is up: its socket is there (ydotoold's default places). */
function ydotoolDaemon(): boolean {
  const sock = process.env.YDOTOOL_SOCKET || "";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return [sock, `/run/user/${uid}/.ydotool_socket`, "/tmp/.ydotool_socket"].some((f) => !!f && existsSync(f));
}
/** Under Wayland, ydotool when it's here and running: xdotool there reaches XWayland's windows, not the desktop's own. */
async function waylandInput(): Promise<boolean> {
  return waylandSession() && (await has("ydotool")) && ydotoolDaemon();
}

/** Linux: xdotool under X (and XWayland), ydotool under Wayland. */
async function linuxPerform(ops: Op[], signal?: AbortSignal): Promise<string | null> {
  const wayland = await waylandInput();
  const tool = wayland ? "ydotool" : "xdotool";
  for (const o of ops) {
    if (signal?.aborted) return "Stopped.";
    let args: string[] | null = null;
    if (o.t === "pause") {
      await new Promise((r) => setTimeout(r, o.ms));
      continue;
    }
    if (!wayland) {
      args =
        o.t === "move" ? ["mousemove", "--sync", String(o.x), String(o.y)]
        : o.t === "down" ? ["mousedown", o.b === "right" ? "3" : "1"]
        : o.t === "up" ? ["mouseup", o.b === "right" ? "3" : "1"]
        : o.t === "click" ? ["click", "--repeat", String(o.n), "--delay", "40", o.b === "right" ? "3" : "1"]
        : o.t === "scroll" ? ["click", "--repeat", String(Math.abs(o.dy || o.dx)), o.dy > 0 ? "4" : o.dy < 0 ? "5" : o.dx < 0 ? "6" : "7"]
        : o.t === "key" ? ["key", "--clearmodifiers", [...o.mods.map((m) => X_MOD[m]), xKey(o.key)].join("+")]
        : ["type", "--delay", "8", "--", o.s];
    } else {
      const code = o.t === "key" ? EVDEV[o.key] : undefined;
      args =
        o.t === "move" ? ["mousemove", "--absolute", "-x", String(o.x), "-y", String(o.y)]
        : o.t === "down" ? ["click", o.b === "right" ? "0x41" : "0x40"]
        : o.t === "up" ? ["click", o.b === "right" ? "0x81" : "0x80"]
        : o.t === "click" ? ["click", "--repeat", String(o.n), o.b === "right" ? "0xC1" : "0xC0"]
        : o.t === "scroll" ? ["mousemove", "--wheel", "-x", String(o.dx), "-y", String(o.dy)]
        : o.t === "key"
          ? code === undefined
            ? null
            : ["key", ...o.mods.map((m) => `${EVDEV_MOD[m]}:1`), `${code}:1`, `${code}:0`, ...[...o.mods].reverse().map((m) => `${EVDEV_MOD[m]}:0`)]
          : ["type", "--", o.s];
      if (!args) return `${o.t === "key" ? o.key : o.t} can't be sent under Wayland here.`;
    }
    const r = await run(tool, args, { signal }).catch((e: Error) => ({ code: -1, out: Buffer.alloc(0), err: e.message }));
    if (signal?.aborted) return "Stopped.";
    if (r.code !== 0)
      return /ENOENT/.test(r.err)
        ? wayland
          ? "Under Wayland Friday needs ydotool and its daemon (`sudo apt install ydotool`, then `ydotoold`), or an X session with xdotool."
          : "Friday needs xdotool to use the mouse and keys here (`sudo apt install xdotool`)."
        : `${tool} didn't take it: ${r.err.trim() || r.code}`;
  }
  return null;
}

/** What each OS is called, for the tool's description. */
export const OS_NAME: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/**
 * One `computer` call, done here: the action, a moment for the screen to settle, and the screen as it is now as the answer, so
 * the agent sees what its action did without asking again. `last` is the screenshot its points are read against.
 */
export async function act(a: ComputerAct, last: Screen | null, signal?: AbortSignal): Promise<{ answer: MeshAnswer; screen: Screen | null }> {
  // One action at a time, whoever asks: two agents' clicks and typing mixed on one screen (and the clipboard a paste borrows) did
  // neither's work.
  const turn = actQueue.then(() => actNow(a, last, signal));
  actQueue = turn.then(() => undefined, () => undefined);
  return turn;
}
let actQueue: Promise<void> = Promise.resolve();

/** macOS's Accessibility as the desktop app last said, for a few seconds: without it the system drops input and says nothing. */
let macInput: { ok: boolean; at: number } | null = null;
async function macInputOk(): Promise<boolean> {
  if (process.platform !== "darwin" || !hasDesktop() || fake()) return true;
  if (macInput && Date.now() - macInput.at < 10_000) return macInput.ok;
  const s = await desk("screen.status", {}, 5000);
  macInput = { ok: s.error ? true : s.accessibility === true, at: Date.now() };
  return macInput.ok;
}

async function actNow(a: ComputerAct, last: Screen | null, signal?: AbortSignal): Promise<{ answer: MeshAnswer; screen: Screen | null }> {
  if (signal?.aborted) return { answer: { output: "Stopped.", isError: true }, screen: last };
  let ref = last;
  const pointing = a.action !== "screenshot" && a.action !== "wait" && a.action !== "type" && a.action !== "key";
  if (pointing && !ref) {
    // Points mean nothing before a screenshot: nothing is done, and the agent is shown the screen to give them against.
    const s = await screenshot();
    if ("error" in s) return { answer: { output: s.error, isError: true }, screen: null };
    return { answer: { content: [{ type: "image", data: s.data, mimeType: s.mimeType }, { type: "text", text: `Nothing done yet: this is the screen to give points against, ${s.width}×${s.height} pixels. Ask again with x and y in it.` }] }, screen: s };
  }
  const ops = opsFor(a, (x, y) => (ref ? toScreen(ref, x, y) : { x, y }));
  if (typeof ops === "string") return { answer: { output: ops, isError: true }, screen: last };
  if (ops.some((o) => o.t !== "pause") && !(await macInputOk()))
    return { answer: { output: "macOS isn't letting Friday use the mouse and keyboard: allow Friday under System Settings › Privacy & Security › Accessibility, then try again.", isError: true }, screen: last };
  const mouse = ops.some((o) => o.t === "move" || o.t === "down" || o.t === "click" || o.t === "scroll");
  if (mouse) sayActing(true);
  let failed: string | null;
  try {
    failed = await perform(ops, process.platform, signal);
  } finally {
    if (mouse) sayActing(false);
  }
  if (failed) return { answer: { output: failed, isError: true }, screen: last };
  if (a.action !== "screenshot") await new Promise((r) => setTimeout(r, a.action === "wait" ? 0 : 450));
  if (signal?.aborted) return { answer: { output: "Stopped.", isError: true }, screen: last };
  const s = await screenshot();
  const cut = a.action === "type" && (a.text?.length ?? 0) > 4000 ? ` Only its first 4,000 characters were typed: type the rest in another call.` : "";
  if ("error" in s) return { answer: { output: a.action === "screenshot" ? s.error : `Done, but the screen couldn't be seen after: ${s.error}${cut}`, isError: a.action === "screenshot" }, screen: last };
  const said = a.action === "screenshot" ? "The screen now" : `Did ${a.action.replace("_", " ")}.${cut} The screen now`;
  return {
    answer: { content: [{ type: "image", data: s.data, mimeType: s.mimeType }, { type: "text", text: `${said}, ${s.width}×${s.height}: give points in these pixels.` }] },
    screen: s,
  };
}

// ── what this computer needs, for Settings ────────────────────────────────────────────────────────────────────────────────────

/** What Settings › Computer says of computer use here: whether it's on, and what the system still needs before it works. */
export interface ComputerStatus {
  on: boolean;
  os: string;
  /** Things to do first, each a short line ("Allow Friday under … Accessibility"); none when it works as it is. */
  needs: string[];
  /** macOS: a press opens the system's prompts and settings for what is missing (computerAllow). */
  canAllow: boolean;
}

const has = (cmd: string) => run(process.platform === "win32" ? "where" : "which", [cmd]).then((r) => r.code === 0, () => false);

export async function computerStatus(): Promise<ComputerStatus> {
  const on = await computerUseOn();
  const os = OS_NAME[process.platform] ?? process.platform;
  const needs: string[] = [];
  let canAllow = false;
  if (process.platform === "darwin") {
    const s = hasDesktop() ? await desk("screen.status", {}, 5000) : null;
    if (s && !s.error) {
      if (s.screen !== "granted") needs.push("Allow Friday under System Settings › Privacy & Security › Screen Recording, so agents can see the screen.");
      if (s.accessibility !== true) needs.push("Allow Friday under System Settings › Privacy & Security › Accessibility, so agents can use the mouse and keyboard.");
      canAllow = needs.length > 0;
    }
  } else if (process.platform === "linux") {
    if (waylandSession()) {
      // xdotool, over XWayland, reaches only the apps that run there: ydotool and its daemon reach them all.
      if (!(await has("ydotool"))) needs.push("Install ydotool and start its daemon (sudo apt install ydotool; ydotoold), so agents can use the mouse and keyboard in every app under Wayland.");
      else if (!ydotoolDaemon()) needs.push("Start ydotool's daemon (ydotoold), so agents can use the mouse and keyboard under Wayland.");
    } else if (!(await has("xdotool"))) needs.push("Install xdotool (sudo apt install xdotool), for the mouse and keyboard.");
    if (!hasDesktop()) {
      const any = await Promise.all(["grim", "import", "scrot", "gnome-screenshot", "spectacle"].map(has));
      if (!any.some(Boolean)) needs.push("Install a screenshot tool (sudo apt install imagemagick), so agents can see the screen.");
    }
  }
  return { on, os, needs, canAllow };
}

/** macOS: the system's prompts for what is missing, and its settings opened there. */
export async function computerAllow(): Promise<ComputerStatus> {
  if (process.platform === "darwin" && hasDesktop()) await desk("screen.allow", {}, 5000);
  return computerStatus();
}
