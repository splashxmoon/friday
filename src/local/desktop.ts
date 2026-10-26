/**
 * Friday's desktop app, the open-source edition: the same Friday as `npx github:splashxmoon/friday` (start.ts), in a window of
 * its own instead of a browser tab. Built by scripts/build-local-desktop.mts and packaged by electron-builder; released from
 * GitHub Actions (.github/workflows/release.yml).
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, shell } from "electron";
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

function open(url: string) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    return win.focus();
  }
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "Friday",
    backgroundColor: "#141416",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
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
  app.on("second-instance", () => friday && open(friday.url));
  app.whenReady().then(async () => {
    if (process.platform === "darwin") Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
    await loginPath;
    friday = await startLocal();
    open(friday.url);
    app.on("activate", () => friday && open(friday.url));
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
