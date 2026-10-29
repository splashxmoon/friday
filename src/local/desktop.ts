/**
 * Friday's desktop app, the open-source edition: the same Friday as `npx github:splashxmoon/friday` (start.ts), in a window of
 * its own instead of a browser tab. Built by scripts/build-local-desktop.mts and packaged by electron-builder; released from
 * GitHub Actions (.github/workflows/release.yml).
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from "electron";
import { powerSaveBlocker } from "electron";
import { MAC_CSS, THEME_WATCH, WIN_CSS } from "../desktop-chrome.js";
import { registerNative } from "../desktop-native.js";
import { registerBrowser } from "./desktop-browser.js";
import { registerTerminal, stopTerminals } from "../desktop-terminal.js";
import { registerUpdates } from "../desktop-update.js";
import { startLocal, type Started } from "./start.js";

const here = path.dirname(fileURLToPath(import.meta.url));
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
 * The window's own buttons in the page's colours, as the product app draws them (desktop/main.ts): on Windows and Linux the
 * title bar is hidden and its buttons drawn over the page, in these colours, 40px tall to fit the page's header. macOS keeps its
 * traffic lights, set into the header.
 */
const OVERLAY = {
  dark: { color: "#1c1c1c", symbolColor: "#ededed", height: 40 },
  light: { color: "#ffffff", symbolColor: "#18181b", height: 40 },
} as const;
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

function open(url: string) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    return win.focus();
  }
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: "Friday",
    backgroundColor: OVERLAY[lastTheme()].color,
    show: false,
    autoHideMenuBar: true,
    // No title bar: the page draws its own header there, as in the product app. On macOS the traffic lights sit in it, 17px down
    // so their centre lines up with the header's; elsewhere the window's buttons are drawn over its right end.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 17 } }
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
  win.once("ready-to-show", () => win?.show());
  // The product app's window chrome (desktop-chrome.ts): the header band that drags, with the window's buttons in it, and the
  // page laid out below it; and the page's light or dark choice reported back for the window's buttons.
  win.webContents.on("did-finish-load", () => {
    void win?.webContents.insertCSS(process.platform === "darwin" ? MAC_CSS : WIN_CSS);
    void win?.webContents.executeJavaScript(THEME_WATCH).catch(() => {});
  });
  // The window is Friday's, whatever a page calls itself.
  win.on("page-title-updated", (e) => e.preventDefault());
  // Friday's own pages stay in the window; anything else (GitHub, a docs link, Friday Team) opens in the browser.
  const own = (u: string) => u.startsWith(url);
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
    const f = e.frame;
    if (f && (f.url === "about:srcdoc" || f.origin === "null")) e.preventDefault();
  });
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

/** A request from Friday's own page in one of its windows, never a previewed site or a page it was sent to. */
const fromApp = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
  !!friday && !!BrowserWindow.fromWebContents(e.sender) && (e.senderFrame?.url ?? e.sender.getURL()).startsWith(friday.url);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Choosing where a coding agent works, in the system's own folder picker: all the page gets back is the path chosen.
  ipcMain.handle("friday:pick-folder", async (e) => {
    if (!win || !fromApp(e)) return null;
    const r = await dialog.showOpenDialog(win, { title: "Choose the folder your coding agent works in", properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  // Real shells for the terminal panel (desktop-terminal.ts), as in the product app.
  registerTerminal(fromApp);
  // "Open in" your editor, file manager or terminal, and the dock's count of what waits on you (desktop-native.ts).
  registerNative(fromApp);
  registerBrowser(() => win, fromApp, () => friday?.url ?? null); // the agents' browser tool, on the session's Browser panel (desktop-browser.ts)
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
      win.setBackgroundColor(OVERLAY[which].color);
      if (process.platform !== "darwin") win.setTitleBarOverlay(OVERLAY[which]);
    } catch {
      // Not every platform draws an overlay; the window is fine without one.
    }
  });
  app.on("second-instance", () => friday && open(friday.url));
  app.whenReady().then(async () => {
    if (process.platform === "darwin") Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
    lockPreview();
    await loginPath;
    friday = await startLocal();
    open(friday.url);
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
  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting || !friday) return;
    quitting = true;
    e.preventDefault();
    stopTerminals();
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    void Promise.race([friday.close(), new Promise((r) => setTimeout(r, 5000))]).finally(() => app.exit(0));
  });
}
