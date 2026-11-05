// Computer use's side in the desktop app (src/runner/computer.ts): the screen as a picture, on macOS, Windows and Linux alike
// (desktopCapturer), the bar that says an agent is using the computer, with Stop, and macOS's two permissions. Both shells: the
// open-source app runs the runner in its own process and hands it this as its driver (local/desktop.ts registerScreen); Friday's
// own app answers its runner child over the channel it started it with (desktop/main.ts onScreenMessage): `screen.capture`,
// `screen.status` and `screen.allow` answered with `screen.done`, `screen.using` to show or hide the bar, Stop sent as `screen.stop`.
import type { ChildProcess } from "node:child_process";
import { setScreenDriver } from "./runner/computer.js";
import { BrowserWindow, desktopCapturer, screen, shell, systemPreferences } from "electron";

type Ask = { kind?: string; id?: string; maxWidth?: number; lane?: string; name?: string | null };

let bar: BrowserWindow | null = null;
/** Bars Friday is closing itself, told from the person's Stop. */
const closing = new Set<BrowserWindow>();
function closeBar(): void {
  if (bar && !bar.isDestroyed()) {
    closing.add(bar);
    bar.destroy();
  }
  bar = null;
}
/** Who is using the computer now, by lane: the bar shows while anyone is. */
const using = new Map<string, string>();
/** How Stop reaches the runner whose lanes these are: the latest one to show the bar (a runner started again is a new one). */
let stopVia: (key: string) => void = () => {};

/** The agent's mouse is acting: the bar lets clicks through, so one meant for the window under it never lands on the bar. */
function acting(on: boolean): void {
  if (bar && !bar.isDestroyed()) bar.setIgnoreMouseEvents(on);
}

const BAR_W = 420;
const BAR_H = 44;

function barHtml(names: string[]): string {
  const who = names.length === 1 ? names[0]! : `${names.length} agents`;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:transparent;font:500 13px -apple-system,"Segoe UI",system-ui,sans-serif;-webkit-user-select:none;user-select:none}
    .b{box-sizing:border-box;height:${BAR_H}px;display:flex;align-items:center;gap:10px;padding:0 6px 0 14px;border-radius:12px;background:rgba(24,24,27,.92);color:#fafafa;box-shadow:0 8px 24px rgba(0,0,0,.25),inset 0 0 0 1px rgba(255,255,255,.08);-webkit-app-region:drag}
    .d{width:8px;height:8px;border-radius:50%;background:#3b82f6;box-shadow:0 0 0 0 rgba(59,130,246,.6);animation:p 1.6s ease-out infinite}
    @keyframes p{to{box-shadow:0 0 0 8px rgba(59,130,246,0)}} @media (prefers-reduced-motion:reduce){.d{animation:none}}
    .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    button{-webkit-app-region:no-drag;height:30px;padding:0 14px;border:0;border-radius:8px;background:#fafafa;color:#18181b;font:600 13px inherit;cursor:pointer}
    button:hover{background:#e4e4e7}
  </style><div class="b"><i class="d"></i><span class="t">${esc(who)} is using your computer</span><button id="s">Stop</button></div>
  <script>document.getElementById('s').onclick=()=>window.close()</script>`;
}

function showBar(stop: (key: string) => void): void {
  stopVia = stop;
  const names = [...new Set(using.values())];
  if (!names.length) {
    closeBar();
    return;
  }
  if (!bar || bar.isDestroyed()) {
    const d = screen.getPrimaryDisplay().workArea;
    bar = new BrowserWindow({
      width: BAR_W,
      height: BAR_H,
      x: Math.round(d.x + (d.width - BAR_W) / 2),
      y: d.y + 12,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    bar.setAlwaysOnTop(true, "screen-saver");
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Kept out of the agent's own screenshots (macOS and Windows): it sees the screen as the person would without it.
    bar.setContentProtection(true);
    // Stop, from the page: it closes its window, and every agent using the computer is stopped. Closed by Friday (nobody is
    // using it any more), it isn't a stop.
    const mine = bar;
    mine.on("closed", () => {
      if (bar === mine) bar = null;
      if (closing.has(mine)) return void closing.delete(mine);
      for (const lane of using.keys()) stopVia(lane);
      using.clear();
    });
    bar.once("ready-to-show", () => bar?.showInactive());
  }
  void bar.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barHtml(names))}`);
}

/** The primary screen, at most `maxWidth` wide, and where it sits in the mouse's coordinates. */
async function capture(maxWidth: number): Promise<Record<string, unknown>> {
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    // Asking is a capture: the first one brings up the system's prompt and puts Friday in the list.
    void desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    return { error: "Friday can't see the screen yet: allow it under System Settings › Privacy & Security › Screen Recording, then try again." };
  }
  const d = screen.getPrimaryDisplay();
  // Linux can't keep a window out of a capture (setContentProtection does nothing there): the bar steps aside for it.
  const hide = process.platform === "linux" && bar && !bar.isDestroyed() && bar.isVisible() ? bar : null;
  if (hide) {
    hide.hide();
    await new Promise((r) => setTimeout(r, 120));
  }
  try {
    return await captureShown(d, maxWidth);
  } finally {
    if (hide && !hide.isDestroyed() && bar === hide) hide.showInactive();
  }
}

async function captureShown(d: Electron.Display, maxWidth: number): Promise<Record<string, unknown>> {
  const k = Math.min(1, maxWidth / d.size.width);
  const size = { width: Math.round(d.size.width * k), height: Math.round(d.size.height * k) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(d.id)) ?? sources[0];
  if (!src || src.thumbnail.isEmpty()) return { error: "The screen came back empty." };
  const img = src.thumbnail;
  const got = img.getSize();
  // The mouse moves in points on macOS, and in physical pixels under X and on Windows (its PowerShell is made DPI-aware).
  const scale = process.platform === "darwin" ? 1 : d.scaleFactor;
  return {
    data: img.toPNG().toString("base64"),
    mimeType: "image/png",
    width: got.width,
    height: got.height,
    bounds: { x: d.bounds.x * scale, y: d.bounds.y * scale, width: d.bounds.width * scale, height: d.bounds.height * scale },
  };
}

/** What this computer lets an agent do with it, as the system says: macOS's two permissions; elsewhere nothing to allow. */
function status(): Record<string, unknown> {
  if (process.platform !== "darwin") return { screen: "granted", accessibility: true };
  return { screen: systemPreferences.getMediaAccessStatus("screen"), accessibility: systemPreferences.isTrustedAccessibilityClient(false) };
}

/** macOS: the system's prompts for both, and the settings pane of what is still missing. */
function allow(): Record<string, unknown> {
  if (process.platform !== "darwin") return status();
  const s = status();
  if (!s.accessibility) systemPreferences.isTrustedAccessibilityClient(true);
  if (s.screen !== "granted") {
    void desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  } else if (!s.accessibility) void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  return status();
}

/** Answers the runner's computer-use asks. Called with each message it sends. */
export function onScreenMessage(child: ChildProcess, m: Ask): boolean {
  if (!m?.kind?.startsWith("screen.")) return false;
  if (m.kind === "screen.using") {
    if (typeof m.lane !== "string") return true;
    if (m.name) using.set(m.lane, m.name);
    else using.delete(m.lane);
    showBar((lane) => child.connected && child.send({ kind: "screen.stop", lane }));
    return true;
  }
  if (m.kind === "screen.acting") {
    acting((m as { on?: unknown }).on === true);
    return true;
  }
  const id = m.id;
  if (typeof id !== "string") return true;
  const reply = (r: Record<string, unknown>) => child.connected && child.send({ kind: "screen.done", id, ...r });
  if (m.kind === "screen.capture")
    void capture(typeof m.maxWidth === "number" ? m.maxWidth : 1280)
      .then(reply)
      .catch((e: Error) => reply({ error: e.message || "Couldn't capture the screen." }));
  else if (m.kind === "screen.status") reply(status());
  else if (m.kind === "screen.allow") reply(allow());
  return true;
}

/** The open-source app: its own runner, in this process, uses these directly (computer.ts setScreenDriver). */
export function registerScreen(): void {
  const stops = new Set<(key: string) => void>();
  const stop = (key: string) => stops.forEach((f) => f(key));
  setScreenDriver({
    capture: (maxWidth) => capture(maxWidth).catch((e: Error) => ({ error: e.message || "Couldn't capture the screen." })),
    using: (key, name) => {
      if (name) using.set(key, name);
      else using.delete(key);
      showBar(stop);
    },
    acting,
    status: async () => status(),
    allow: async () => allow(),
    onStop: (fn) => void stops.add(fn),
  });
}

/** The runner went: nobody is using the computer through it any more. */
export function screenRunnerGone(): void {
  using.clear();
  closeBar();
}
