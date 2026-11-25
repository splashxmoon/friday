/**
 * Friday's desktop app, the open-source edition: the same Friday as `npx github:splashxmoon/friday` (start.ts), in a window of
 * its own instead of a browser tab. Built by scripts/build-local-desktop.mts and packaged by electron-builder; released from
 * GitHub Actions (.github/workflows/release.yml).
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, powerMonitor, session, shell, systemPreferences } from "electron";
import { powerSaveBlocker } from "electron";
import { MAC_CSS, THEME_WATCH, WIN_CSS } from "../desktop-chrome.js";
import { registerNative } from "../desktop-native.js";
import { feedbackUrl, osName } from "../feedback.js";
import { defaultHome, diagnostics, installProcessLog, logLine, logPath, processLog } from "../diagnostics.js";
import { bootPage, bootPageUrl } from "./boot-page.js";
import { CrashGuard, errorPage, errorPageUrl, goneWords } from "./crash-recovery.js";
import { registerBrowser } from "./desktop-browser.js";
import { registerTray } from "./desktop-tray.js";
import { registerScreen } from "../desktop-screen.js";
import { registerTerminal, stopTerminals } from "../desktop-terminal.js";
import { registerUpdates } from "../desktop-update.js";
import { killTools } from "../runner/spawn-cli.js";
import { setBrowserCaches, sizeOf } from "../runner/storage.js";
import { watchBorrowed } from "./borrowed.js";
import { isOwnUrl } from "./own-url.js";
import { startLocal, type Started } from "./start.js";
import { setWindowOpener } from "./window-opener.js";
import { capturePreview, recordClip } from "../desktop-capture.js";
import { useInProcessCapture } from "../runner/screenshot.js";
import { VSCODE_HELP, VSCODE_MENUS, type VsMenuItem } from "../vscode-menu.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * This process's log (diagnostics.ts), first of all: the server, runner and store all run in it, and an error in any of them showed
 * Electron's own dialog with a stack, or nothing, and was written nowhere. Now it is logged to <FRIDAY_HOME>/diagnostics/friday.log
 * and the app carries on, as the server and the runner do on their own (spec 13; Arun, 2026-11-24: "Go all out and fix these problems").
 */
installProcessLog(defaultHome(), { what: "The desktop app" });
// The page as built ahead (scripts/build-local-desktop.mts), so the app needs no bundler.
process.env.CLIENT_DIR ||= path.join(here, "client");

/**
 * A Mac or Linux app opened from the Dock gets the system's bare PATH, not the one your shell builds, which is where Homebrew,
 * nvm and ~/.local/bin put `claude`, `codex` and the rest. Read once from a login shell, five seconds at most, before anything
 * looks for a coding tool; a slow or broken shell profile leaves the PATH as it was.
 */
const loginPath: Promise<void> =
  process.platform === "win32"
    ? Promise.resolve()
    : new Promise((resolve) => {
        const sh = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
        const child = execFile(sh, ["-ilc", 'printf "__FRIDAY_PATH__%s__FRIDAY_PATH__" "$PATH"'], { timeout: 5000, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } }, (_err, out) => {
          const found = /__FRIDAY_PATH__(.*?)__FRIDAY_PATH__/s.exec(String(out ?? ""))?.[1];
          if (found) process.env.PATH = [...new Set([...found.split(":"), ...(process.env.PATH ?? "").split(":")].filter(Boolean))].join(":");
          resolve();
        });
        child.stdin?.end();
      });

let friday: Started | null = null;
let win: BrowserWindow | null = null;
/** Quitting: the window going isn't a crash to recover from. */
let quitting = false;

/**
 * The window's page dying (out of memory on a long log, a GPU fault, the system killing it) left it white with nothing to press:
 * loaded again at once, three times a minute at most, then a small page of its own with Reload, Copy diagnostics and Show log
 * file (crash-recovery.ts). Each is logged with its reason.
 */
const crashes = new CrashGuard();
function recoverPage(reason: string, exitCode: number): void {
  const w = win;
  if (quitting || !w || w.isDestroyed()) return;
  logLine(reason === "clean-exit" ? "info" : "error", `The window's page ${goneWords(reason)} (${reason}, exit code ${exitCode})`);
  const next = crashes.gone(reason);
  if (next === "none" || !friday) return;
  if (next === "reload") {
    logLine("info", `Reloading the window (${crashes.recent} of ${crashes.max} in a minute)`);
    void w.loadURL(friday.url).catch(() => {});
    return;
  }
  // The error page dying too, again and again: left as it is rather than loaded for ever.
  if (crashes.recent > crashes.max + 2) return;
  logLine("error", `The window's page stopped ${crashes.recent} times in a minute: showing the error page`);
  void w.loadURL(errorPageUrl(errorPage({ reason, times: crashes.max }))).catch(() => {});
}
/**
 * Whether the window shows a page of its own now, the error page or the one shown while Friday starts (boot-page.ts), not the
 * app's: the error page's buttons are answered for it only, and neither gets the app's header styles or its theme watch.
 */
const onErrorPage = (wc: Electron.WebContents) => wc.getURL().startsWith("data:text/html");

// ── Keeping the computer awake while the team works and the person is away ──────────────────────────────────────────────
//
// As the product app keeps it awake while an agent runs (desktop/main.ts syncAwake): here, while away mode is on and the team has
// work in hand (a turn running or queued, a resume or wake due within two hours, a board being worked on), the Mac is kept from
// sleeping when idle, and the app from App Nap (prevent-app-suspension). Closing the lid still sleeps it, which the away switch
// says (Arun, 2026-10-28: "we need to ensure teams can work basically while you are away"). Asked every half minute.
let blocker: number | null = null;
async function syncAwake() {
  const want = !!friday && !!(await friday.awake?.().catch(() => false));
  if (want && blocker === null) blocker = powerSaveBlocker.start("prevent-app-suspension");
  else if (!want && blocker !== null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}
setInterval(() => void syncAwake(), 30_000).unref();

/**
 * The window's own buttons: on Windows and Linux the title bar is hidden and its minimise, maximise and close drawn over the page's
 * top right (macOS keeps its traffic lights, set into the header). 38px tall, the height of the window's top row, so they sit in
 * that row and end where the page's panel begins: at 40 they ran 2px over its top edge and onto its rounded corner (Arun,
 * 2026-11-21: "it should sit flush with the header.... and not overlap it"). Clear, so behind them is the row itself in every look,
 * Frosted and a backdrop included, rather than a block of one colour; the symbols in the theme's ink.
 */
const OVERLAY = {
  dark: { color: "#00000000", symbolColor: "#ededed", height: 38 },
  light: { color: "#00000000", symbolColor: "#18181b", height: 38 },
} as const;
/** The window's own colour before the page paints: the page's (--bg). */
const WINDOW_BG = { dark: "#1c1c1c", light: "#fafaf9" } as const;
const themeFile = () => path.join(app.getPath("userData"), "theme");
/** The theme the page last showed, so the window opens in it rather than flashing the other one. */
function lastTheme(): "dark" | "light" {
  try {
    const t = readFileSync(themeFile(), "utf8").trim();
    if (t === "dark" || t === "light") return t;
  } catch {
    // Not chosen yet: the system's.
  }
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

/**
 * Frosted glass (Arun, 2026-11-16: "a frosted glass effect"): the window shows the desktop behind it through the system's own
 * blur, the macOS vibrancy the menu bar panel has, Windows 11's acrylic. Kept, so the window opens in it. Elsewhere the page draws
 * its own soft ground instead (html.glass without .glass-native).
 */
const glassFile = () => path.join(app.getPath("userData"), "glass");
const lastGlass = (): boolean => {
  try {
    return readFileSync(glassFile(), "utf8").trim() === "1";
  } catch {
    return false;
  }
};
const GLASS_NATIVE = process.platform === "darwin" || process.platform === "win32";
function setGlass(w: BrowserWindow, on: boolean, theme: "dark" | "light") {
  try {
    if (process.platform === "darwin") w.setVibrancy(on ? "under-window" : null);
    else if (process.platform === "win32") w.setBackgroundMaterial(on ? "acrylic" : "none");
    w.setBackgroundColor(on && GLASS_NATIVE ? "#00000000" : WINDOW_BG[theme]);
  } catch {
    // An older system without the material: the page's own glass ground stands in.
  }
}

function open(url: string) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    // From the Dock, a second launch or the menu bar, Friday isn't the active app: focus() alone left its window behind the one
    // in front on macOS. It is brought forward too.
    if (process.platform === "darwin") app.focus({ steal: true });
    return win.focus();
  }
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: "Friday",
    backgroundColor: lastGlass() && GLASS_NATIVE ? "#00000000" : WINDOW_BG[lastTheme()],
    ...(lastGlass() && process.platform === "darwin" ? { vibrancy: "under-window" as const, visualEffectState: "followWindow" as const } : {}),
    ...(lastGlass() && process.platform === "win32" ? { backgroundMaterial: "acrylic" as const } : {}),
    show: false,
    autoHideMenuBar: true,
    // No title bar: the page draws its own header there, as in the product app. On macOS the traffic lights sit in it, 14px down
    // (centre 20px down, Arun 2026-11-16: "move everything up slightly"), and the header's row lines up with them (style.css); elsewhere the window's buttons are drawn over its right end.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarStyle: "hidden" as const, titleBarOverlay: OVERLAY[lastTheme()] }),
    // webviewTag: the Preview panel draws the app being built in a <webview>, locked down below.
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      preload: path.join(here, "preload.cjs"),
    },
  });
  // A preview's <webview> is somebody's dev server's page: its own cookie jar, nothing of Node's, and no permissions (location,
  // camera, external apps), whatever the page that made it asked for (lockPreview, set when the app starts). As in the product
  // app (desktop/main.ts).
  win.webContents.on("will-attach-webview", (_e, prefs) => {
    prefs.partition = "persist:preview";
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.sandbox = true;
    prefs.contextIsolation = true;
    delete prefs.preload;
  });
  // Friday's own keys while focus is inside Code's VS Code (a frame of another origin that keeps its keys from the page): ⌘E is the
  // Agents/Code switch and ⌘⌥B the agent column. before-input-event hears subframes too, so they are caught here and sent to the page
  // as the keys Code's handlers already know. Only while a subframe has focus: on the page itself its own handlers run.
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || input.shift) return;
    const mac = process.platform === "darwin";
    const mod = mac ? input.meta && !input.control : input.control && !input.meta;
    if (!mod) return;
    const key = input.key.toLowerCase();
    const wantMode = key === "e" && !input.alt;
    const wantAgent = input.alt && (input.code === "KeyB" || key === "b");
    if (!wantMode && !wantAgent) return;
    const wc = win?.webContents;
    const focused = wc?.focusedFrame;
    if (!wc || !focused || focused === wc.mainFrame) return;
    e.preventDefault();
    const code = wantMode ? "KeyE" : "KeyB";
    void wc
      .executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent("keydown",{code:${JSON.stringify(code)},key:${JSON.stringify(code === "KeyE" ? "e" : "b")},metaKey:${mac},ctrlKey:${!mac},altKey:${wantAgent},bubbles:true,cancelable:true}))`,
      )
      .catch(() => {});
  });
  win.once("ready-to-show", () => win?.show());
  // Whether the window is in full screen, where macOS hides its buttons (preload.ts onFullScreen): the page guessed it from its
  // size, and a window that filled the screen or had just left full screen kept the guess, its back and forward buttons under
  // the traffic lights (Arun, 2026-10-29).
  const sayFull = () => win?.webContents.send("friday:full-screen", win.isFullScreen());
  win.on("enter-full-screen", sayFull);
  win.on("leave-full-screen", sayFull);
  // The product app's window chrome (desktop-chrome.ts): the header band that drags, with the window's buttons in it, and the
  // page laid out below it; and the page's light or dark choice reported back for the window's buttons.
  win.webContents.on("did-finish-load", () => {
    // Not on the error page: it has no header, and the theme watch would read it as light and turn the whole app light.
    if (!win || onErrorPage(win.webContents)) return;
    void win?.webContents.insertCSS(process.platform === "darwin" ? MAC_CSS : WIN_CSS);
    void win?.webContents.executeJavaScript(THEME_WATCH).catch(() => {});
  });
  // The window is Friday's, whatever a page calls itself.
  win.on("page-title-updated", (e) => e.preventDefault());
  // Friday's own pages stay in the window; anything else (GitHub, a docs link, Friday Team) opens in the browser.
  // Whichever Friday the window is on now: the one it opened on may have been replaced (begin, below).
  const own = (u: string) => !!friday && isOwnUrl(u, friday.url);
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (!own(u) && /^https?:/.test(u)) void shell.openExternal(u);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, u) => {
    if (own(u)) return;
    e.preventDefault();
    if (/^https?:/.test(u)) void shell.openExternal(u);
  });
  // A page drawn from text in a frame with no origin of its own (a Work session's page an agent made, a live visual in the chat)
  // never leaves for another address: will-navigate above hears the window's own page only, and a frame's script could carry
  // what it read to anywhere in its address (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
  win.webContents.on("will-frame-navigate", (e) => {
    if (e.isMainFrame || /^about:/i.test(e.url)) return;
    // A backdrop's page (backdrop.tsx): a frame sandboxed from the start has no origin either, so its first load, of Friday's own
    // walled-off backdrop file, was refused and it stayed blank. Only that path; anywhere else is still refused.
    if (own(e.url) && new URL(e.url).pathname.startsWith("/api/local/backdrops/f/")) return;
    const f = e.frame;
    if (f && (f.url === "about:srcdoc" || f.origin === "null")) e.preventDefault();
  });
  win.webContents.on("render-process-gone", (_e, d) => recoverPage(d.reason, d.exitCode));
  // A page stuck (a long synchronous render): said in the log, so a hang someone reports can be seen there.
  win.on("unresponsive", () => logLine("warn", "The window stopped responding"));
  win.on("responsive", () => logLine("info", "The window is responding again"));
  win.on("closed", () => (win = null));
  void win.loadURL(url);
}

/**
 * The Preview's cookie jar (persist:preview) granted nothing: no permission, device, or screen or window to capture. Set when the
 * app starts, before any page uses it: set only as the first webview was drawn, a page of that jar loaded before then (in a
 * window of its own) had Electron's default, which grants everything (Arun, 2026-10-28: "iron everything and
 * ensure we are good… any logic errors").
 */
function lockPreview(): void {
  const preview = session.fromPartition("persist:preview");
  preview.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  preview.setPermissionCheckHandler(() => false);
  preview.setDevicePermissionHandler(() => false);
  // No streams is a refusal.
  preview.setDisplayMediaRequestHandler((_r, cb) => {
    try {
      cb({});
    } catch {
      // The frame that asked has gone: nothing to refuse.
    }
  });
}

/**
 * The microphone, for voice input (client/voice.ts): Friday's own page may have it, sound only, never a camera; macOS asks the person
 * the first time (NSMicrophoneUsageDescription, scripts/oss-export.mts). A preview never may: it has its own jar, locked above
 * (lockPreview). Every other permission goes to Friday's own page alone.
 */
function allowMicrophone(): void {
  const s = session.defaultSession;
  const ours = (u: string) => !!friday && isOwnUrl(u, friday.url);
  s.setPermissionRequestHandler((_w, permission, cb, details) => {
    // Anything else, for Friday's own page only: a page the window was sent to elsewhere gets nothing it asks for.
    if (permission !== "media") return cb(ours(details.requestingUrl));
    const kinds = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    if (!ours(details.requestingUrl) || !kinds.length || kinds.some((k) => k !== "audio")) return cb(false);
    if (process.platform !== "darwin") return cb(true);
    const now = systemPreferences.getMediaAccessStatus("microphone");
    if (now === "granted") return cb(true);
    if (now !== "not-determined") return cb(false);
    void systemPreferences.askForMediaAccess("microphone").then(cb, () => cb(false));
  });
  s.setPermissionCheckHandler((_w, permission, origin, details) => permission !== "media" || (ours(origin) && (details as { mediaType?: string }).mediaType !== "video"));
}

/** A request from Friday's own page in one of its windows, never a previewed site or a page it was sent to. */
const fromApp = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
  !!friday && !!BrowserWindow.fromWebContents(e.sender) && isOwnUrl(e.senderFrame?.url ?? e.sender.getURL(), friday.url);

/** Waits for a process to be gone, `ms` at most. */
async function exited(pid: number | undefined, ms: number): Promise<void> {
  const alive = () => {
    try {
      return !!pid && process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  for (const end = Date.now() + ms; alive() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 200));
}

/**
 * Friday started for this app, or the one already running on this folder (the terminal edition's) borrowed. A borrowed one is
 * watched: when it stops, this app starts its own and the window goes to it, instead of staying on an address nothing answers.
 */
async function begin(): Promise<boolean> {
  // Friday not starting (its folder can't be written, a disk full) left an app with no window and nothing to say why.
  try {
    // Using this computer (any input in the last two minutes): what an agent needs shows here, and the phone isn't buzzed too.
    // The preview check's pictures and proof clips, taken by this app's own offscreen windows: Friday's runner runs in this process, so
    // it is handed them rather than asking over a channel (runner/screenshot.ts; Arun, 2026-11-21: "not working....").
    useInProcessCapture({ capture: (shot) => capturePreview(shot), clip: (ask) => recordClip(ask) });
    friday = await startLocal({ atComputer: () => powerMonitor.getSystemIdleTime() < 120 });
  } catch (e) {
    console.error("[friday] couldn't start:", e instanceof Error ? (e.stack ?? e.message) : e);
    await processLog()?.flush();
    // The window showing Friday starting goes, so what is said is said over nothing that looks stuck.
    if (win && !win.isDestroyed()) win.hide();
    // Another Friday already holds this data folder (start.ts friday.lock): said as that, not as a failure, since both writing one
    // folder is what lost work before (spec 13).
    if ((e as { code?: string } | null)?.code === "FRIDAY_ALREADY_OPEN") {
      const other = e as { home: string; pid: number };
      await dialog.showMessageBox({
        type: "info",
        message: "Friday is already open",
        detail: `Another Friday is using the same data (${other.home}, process ${other.pid}). Close it, then open this one again.`,
        buttons: ["OK"],
      });
    } else dialog.showErrorBox("Friday couldn't start", e instanceof Error ? e.message : String(e));
    app.exit(1);
    return false;
  }
  if (!friday.already) return true;
  const pid = friday.pid;
  // Started once its process is gone (ten seconds at most): it stops answering before it has written what it keeps, and
  // starting on the folder before then would read it without the last of it.
  watchBorrowed(friday.url, () =>
    void exited(pid, 10_000)
      .then(begin)
      .then((ok) => {
        if (!ok || !friday) return;
        if (win && !win.isDestroyed()) void win.loadURL(friday.url);
        else open(friday.url);
      }),
  );
  return true;
}

/**
 * The browser's caches, the app's own and the Preview's, kept small (Arun, 2026-11-19: "proper storage management so it doesnt pile
 * up"): Chromium let them grow to 1.8 GB, the Preview's mostly, from the dev servers it shows. Held to CACHE_MB each from here,
 * trimmed at the start when one is already over, and cleared from Settings › Storage (runner/storage.ts).
 */
const CACHE_MB = 256;
app.commandLine.appendSwitch("disk-cache-size", String(CACHE_MB * 1024 * 1024));
function keepCachesSmall(): void {
  const data = app.getPath("userData");
  const dirs = ["", path.join("Partitions", "preview")].flatMap((p) => [path.join(data, p, "Cache"), path.join(data, p, "Code Cache")]);
  const jars = () => [session.defaultSession, session.fromPartition("persist:preview")];
  const clear = async () => {
    for (const s of jars()) {
      await s.clearCache();
      await s.clearCodeCaches({});
    }
  };
  setBrowserCaches({ dirs, clear });
  // Over twice the cap (what grew before it, or the compiled scripts' cache, which it doesn't hold): cleared, a minute on.
  setTimeout(() => {
    void sizeOf(dirs)
      .then((b) => (b.reduce((a, x) => a + x, 0) > 2 * CACHE_MB * 1024 * 1024 ? clear() : undefined))
      .catch(() => undefined);
  }, 60_000).unref?.();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Whether the window is in full screen, asked once by the page as it starts (preload.ts onFullScreen); open() says when it changes.
  ipcMain.handle("friday:is-full-screen", (e) => e.sender === win?.webContents && !!win?.isFullScreen());
  // The error page's buttons (crash-recovery.ts), for that page in Friday's window only. Copy diagnostics asks Friday's server, which
  // runs in this process and is still up when only the page died; if it doesn't answer, the same report is made here without it.
  ipcMain.handle("friday:recover", async (e, what: unknown): Promise<{ ok: boolean; error?: string }> => {
    const w = win;
    if (!w || w.isDestroyed() || e.sender !== w.webContents || !onErrorPage(w.webContents)) return { ok: false, error: "Not from Friday's window." };
    if (what === "reload") {
      if (!friday) return { ok: false, error: "Friday isn't running. Quit and open it again." };
      crashes.reset();
      logLine("info", "Reloading the window from the error page");
      void w.loadURL(friday.url).catch(() => {});
      return { ok: true };
    }
    if (what === "copy") {
      const asked = friday
        ? await fetch(`${friday.url}/api/local/diagnostics`, { signal: AbortSignal.timeout(10_000) })
            .then((r) => r.json() as Promise<{ text?: string }>)
            .catch(() => null)
        : null;
      const text = asked?.text ?? (await diagnostics({ home: defaultHome(), version: app.getVersion() }).then((d) => d.text, () => ""));
      if (!text) return { ok: false, error: "The diagnostics couldn't be gathered." };
      clipboard.writeText(text);
      return { ok: true };
    }
    if (what === "log") {
      await processLog()?.flush();
      shell.showItemInFolder(logPath(defaultHome()));
      return { ok: true };
    }
    return { ok: false, error: "Not something this page does." };
  });
  // Another of the app's processes going (the GPU's, a utility's): logged, so a window that went blank or slow has a reason on record.
  app.on("child-process-gone", (_e, d) => logLine(d.reason === "clean-exit" ? "info" : "warn", `The app's ${d.name || d.type} process ${goneWords(d.reason)} (${d.reason}, exit code ${d.exitCode})`));
  // Choosing where a coding agent works, in the system's own folder picker: all the page gets back is the path chosen.
  ipcMain.handle("friday:pick-folder", async (e) => {
    if (!win || !fromApp(e)) return null;
    const r = await dialog.showOpenDialog(win, { title: "Choose the folder your coding agent works in", properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // VS Code's own Open, Open File and Open Folder in Code (vscode-skin.ts nativePickers): the system's picker, as VS Code's desktop
  // app has (Arun, 2026-11-19: "the VScode native open folder needs to open up finder, like we still need to have native controls").
  ipcMain.handle("friday:pick-path", async (e, what: unknown) => {
    if (!win || !fromApp(e)) return null;
    const kind = what === "file" ? "file" : what === "folder" ? "folder" : "any";
    const properties: ("openFile" | "openDirectory" | "createDirectory")[] = kind === "file" ? ["openFile"] : kind === "folder" ? ["openDirectory", "createDirectory"] : ["openFile", "openDirectory"];
    const r = await dialog.showOpenDialog(win, { title: kind === "folder" ? "Open Folder" : "Open", properties });
    const picked = r.canceled ? null : (r.filePaths[0] ?? null);
    if (!picked) return null;
    let dir = kind === "folder";
    try {
      dir = statSync(picked).isDirectory();
    } catch {
      // Gone already: said as what was asked for.
    }
    return { path: picked, dir };
  });
  // Real shells for the terminal panel (desktop-terminal.ts), as in the product app.
  registerTerminal(fromApp);
  // "Open in" your editor, file manager or terminal, and the dock's count of what waits on you (desktop-native.ts).
  registerNative(fromApp);
  registerScreen(); // computer use's screen, bar and permissions, for the runner in this process (desktop-screen.ts)
  registerBrowser(() => win, fromApp, () => friday?.url ?? null); // the agents' browser tool, on the session's Browser panel (desktop-browser.ts)
  // Friday in the menu bar (desktop-tray.ts): its mark, how many work, and a panel to answer and start work without the window.
  const tray = registerTray({
    origin: () => friday?.url ?? null,
    preload: path.join(here, "preload.cjs"),
    showMain: () => {
      if (!friday) return null;
      open(friday.url);
      return win && !win.isDestroyed() ? win : null;
    },
    trusted: fromApp,
  });
  // A thread asked for from outside the window (window-opener.ts: Slack's Open in Friday): the window comes forward on it.
  setWindowOpener((sid, invite) => {
    if (!friday) return false;
    open(friday.url);
    if (!win || win.isDestroyed()) return false;
    const main = win;
    const go = () => void main.webContents.executeJavaScript(`dispatchEvent(new CustomEvent("friday:open-session", { detail: ${JSON.stringify({ sid: sid.slice(0, 80), ...(invite ? { invite: invite.slice(0, 2000) } : {}) })} }))`).catch(() => {});
    if (main.webContents.isLoading()) main.webContents.once("did-finish-load", go);
    else go();
    return true;
  });
  // The page's light or dark choice (preload.ts setTheme): the window buttons and background follow it where the OS draws them.
  ipcMain.on("friday:theme", (e, theme: unknown, choice: unknown) => {
    if (!win || e.sender !== win.webContents) return;
    const which = theme === "light" ? "light" : "dark";
    // The app's own sheets (the folder picker, dialogs, menus) in the page's look: they followed the computer, light over a dark
    // page. System stays the computer's, so the page goes on hearing when that changes (Arun, 2026-10-28: "TEST EVERYTHING…
    // EVERY INTERACTION, EVERY VISUAL").
    nativeTheme.themeSource = choice === "system" ? "system" : which;
    try {
      writeFileSync(themeFile(), which);
      if (!lastGlass()) win.setBackgroundColor(WINDOW_BG[which]);
      if (process.platform !== "darwin") win.setTitleBarOverlay(OVERLAY[which]);
    } catch {
      // Not every platform draws an overlay; the window is fine without one.
    }
  });
  ipcMain.on("friday:glass", (e, on: unknown) => {
    if (!win || e.sender !== win.webContents) return;
    try {
      writeFileSync(glassFile(), on === true ? "1" : "0");
    } catch {
      // Not kept: it still shows now.
    }
    setGlass(win, on === true, lastTheme());
  });
  // The Mac menu bar: Friday's own, or VS Code's while Code is showing (preload.ts setCodeMenu; src/vscode-menu.ts). A VS Code item
  // goes to the page (friday:vsc-menu), which has VS Code run it; its shortcut is shown, not taken, so keys work as they did.
  const feedback = { label: "Send Feedback…", click: () => void shell.openExternal(feedbackUrl({ version: app.getVersion(), os: osName(process.platform), app: true })) };
  const send = (item: { command?: string; friday?: string; path?: string }) => win && !win.isDestroyed() && win.webContents.send("friday:vsc-menu", item);
  // Open Recent's folders: the ones Friday knows, sent by the page with the switch to Code.
  let recentFolders: string[] = [];
  const toPage = (i: VsMenuItem): Electron.MenuItemConstructorOptions[] => {
    if ("sep" in i) return [{ type: "separator" }];
    if ("role" in i) return [{ role: i.role }];
    if ("recent" in i)
      return recentFolders.length
        ? recentFolders.slice(0, 10).map((p) => ({ label: p.replace(/^\/(Users|home)\/[^/]+/, "~"), click: () => send({ friday: "open-recent", path: p }) }))
        : [{ label: "No recent folders", enabled: false }];
    if ("submenu" in i) return [{ label: i.label, submenu: i.submenu.flatMap(toPage) }];
    const item = "command" in i ? { command: i.command } : { friday: i.friday };
    return [{ label: i.label, ...(i.key ? { accelerator: i.key, registerAccelerator: false } : {}), click: () => send(item) }];
  };
  let codeMenu: string | null = null;
  const setMenus = (code: boolean, recent: string[] = []) => {
    // Built again when Code's recent folders change too, so Open Recent is current.
    const sig = code ? JSON.stringify(recent) : "";
    if (process.platform !== "darwin" || codeMenu === sig) return;
    codeMenu = sig;
    recentFolders = recent;
    const template: Electron.MenuItemConstructorOptions[] = code
      ? [
          { role: "appMenu" },
          ...VSCODE_MENUS.map((m) => ({ label: m.label, submenu: m.items.flatMap(toPage) })),
          { role: "windowMenu" },
          { role: "help", submenu: [...VSCODE_HELP.flatMap(toPage), { type: "separator" }, feedback] },
        ]
      : [{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }, { role: "help", submenu: [feedback] }];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  ipcMain.on("friday:code-menu", (e, on: unknown, recent: unknown) => {
    if (!win || e.sender !== win.webContents) return;
    setMenus(on === true, Array.isArray(recent) ? recent.filter((p): p is string => typeof p === "string" && p.length < 2000).slice(0, 10) : []);
  });
  app.on("second-instance", () => {
    if (friday) return open(friday.url);
    // Still starting: the window that shows it comes forward.
    if (win && !win.isDestroyed()) (win.show(), win.focus());
  });
  app.whenReady().then(async () => {
    // Help › Send feedback: a GitHub issue started with this version and system (feedback.ts), in the person's own browser.
    setMenus(false);
    lockPreview();
    allowMicrophone();
    keepCachesSmall();
    // The window at once, showing Friday starting in its own look (boot-page.ts), and the app in it the moment the server answers:
    // it opened only once the whole server had started, half a second with a long history (spec 13, Arun 2026-11-24: "Go all out
    // and fix these problems"). The server listens before it brings back what was going (start.ts restored), so that is soon.
    open(bootPageUrl(bootPage({ theme: lastTheme(), glass: lastGlass() && GLASS_NATIVE })));
    await loginPath;
    if (!(await begin()) || !friday) return;
    if (win && !win.isDestroyed()) void win.loadURL(friday.url).catch(() => {});
    else open(friday.url);
    // The computer waking or unlocking: sleep doesn't hide the page, so its sockets looked open to nothing until their next ping, up
    // to half a minute of "live" over a dead link. Told at once (preload.ts onResume), each open session checks its link now
    // (client/useSession.ts).
    const resumed = (why: string) => {
      logLine("info", `The computer ${why}`);
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("friday:resume");
    };
    powerMonitor.on("resume", () => resumed("woke from sleep"));
    powerMonitor.on("unlock-screen", () => resumed("was unlocked"));
    tray.start();
    app.on("activate", () => friday && open(friday.url));
    // Updates as the product app has them (desktop-update.ts): checked in the background, downloaded, and offered once ready.
    registerUpdates();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  // Quitting closes the window first (so it doesn't reload against a server that's going), then Friday, which writes what
  // it keeps, five seconds at most, then exits outright: a second app.quit() from here can be ignored as a quit already
  // under way, and that left the app running with nothing in it.
  app.on("before-quit", (e) => {
    if (quitting || !friday) return;
    quitting = true;
    e.preventDefault();
    stopTerminals();
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    // A coding tool still running when the five seconds are up is killed: it would outlive the app (spawn-cli.ts).
    void Promise.race([friday.close(), new Promise((r) => setTimeout(r, 5000))]).finally(async () => {
      killTools();
      // The log's last lines on disk, half a second at most.
      await Promise.race([processLog()?.flush(), new Promise((r) => setTimeout(r, 500))]);
      app.exit(0);
    });
  });
}
