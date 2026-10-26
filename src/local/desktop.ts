/**
 * Friday's desktop app, the open-source edition: the same Friday as `npx github:splashxmoon/friday` (start.ts), in a window of
 * its own instead of a browser tab. Built by scripts/build-local-desktop.mts and packaged by electron-builder; released from
 * GitHub Actions (.github/workflows/release.yml).
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { MAC_CSS, THEME_WATCH, WIN_CSS } from "../desktop-chrome.js";
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

/**
 * A newer version, said once per version: the app asks GitHub which release is the latest, a few seconds after it opens and
 * twice a day after that, and offers the download page. Nothing else is sent; FRIDAY_NO_UPDATE_CHECK=1 turns it off.
 * (It doesn't install itself: an app that replaces itself has to be signed first, on macOS above all.)
 */
const RELEASES = "https://github.com/splashxmoon/friday/releases/latest";
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, "").split(/[.-]/).map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) if (x![i]! !== y![i]!) return x![i]! > y![i]!;
  return false;
};
async function checkForUpdate(): Promise<void> {
  if (process.env.FRIDAY_NO_UPDATE_CHECK === "1") return;
  try {
    const r = await fetch("https://api.github.com/repos/splashxmoon/friday/releases/latest", { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return;
    const latest = String(((await r.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "");
    if (!latest || !newer(latest, app.getVersion())) return;
    const file = path.join(app.getPath("userData"), "update.json");
    const told = await readFile(file, "utf8").then((t) => (JSON.parse(t) as { told?: string }).told, () => undefined);
    if (told === latest) return;
    await writeFile(file, JSON.stringify({ told: latest })).catch(() => {});
    const opts = {
      type: "info" as const,
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Friday ${latest} is out`,
      detail: `You have ${app.getVersion()}. Install the new one over this one: your sessions and settings stay where they are.`,
    };
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (response === 0) void shell.openExternal(RELEASES);
  } catch {
    // Offline, or GitHub didn't answer: asked again later.
  }
}

let friday: Started | null = null;
let win: BrowserWindow | null = null;

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
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(here, "preload.cjs") },
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
  win.on("closed", () => (win = null));
  void win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // The page's light or dark choice (preload.ts setTheme): the window buttons and background follow it where the OS draws them.
  ipcMain.on("friday:theme", (e, theme: unknown) => {
    if (!win || e.sender !== win.webContents) return;
    const which = theme === "light" ? "light" : "dark";
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
    await loginPath;
    friday = await startLocal();
    open(friday.url);
    app.on("activate", () => friday && open(friday.url));
    setTimeout(() => void checkForUpdate(), 5_000);
    setInterval(() => void checkForUpdate(), 12 * 60 * 60_000).unref();
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
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    void Promise.race([friday.close(), new Promise((r) => setTimeout(r, 5000))]).finally(() => app.exit(0));
  });
}
