import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from "electron";
import pkg from "electron-updater";

/**
 * Keeping the app up to date: the product app (desktop/main.ts) and the open-source one (src/local/desktop.ts) alike, each from
 * its own release feed.
 *
 * A desktop app that never updates itself is a fork of the product: it keeps
 * talking to a server that has moved on, and the person running it has no way
 * to know which parts of what they are seeing are stale. So the app checks on
 * its own, downloads in the background, and asks once when a version is ready
 * to run — restarting is the one part that has to be theirs, because it closes
 * a window somebody may be working in.
 *
 * The feed is whatever `publish` in package.json points at; electron-builder
 * writes the details into the packaged app, so nothing here names a URL.
 *
 * Nothing runs from a development checkout: there is no packaged app to
 * replace, and electron-updater rightly refuses.
 */

// electron-updater is CommonJS with a default export, which under `import` is
// the module object, not the named binding.
const { autoUpdater } = pkg;

export type UpdateStage = "idle" | "checking" | "available" | "downloading" | "ready" | "current" | "error" | "unsupported";

export interface UpdateState {
  stage: UpdateStage;
  /** The version being offered or installed, when there is one. */
  version?: string;
  /** 0–100 while downloading. */
  percent?: number;
  /** What went wrong, in the updater's own words. */
  error?: string;
  /** This app's version, so the page can show it without asking twice. */
  current: string;
}

/** Ten minutes: a new version is found within minutes of being published, and the feed is a cheap request. */
const EVERY = 10 * 60_000;
/** Just after launch, once the window is up. */
const FIRST = 5_000;
/** Coming back to the app or waking the computer also looks, but never more than once a minute. */
const MIN_GAP = 60_000;
/** After a failed check (offline, a hiccup) the next try is soon, not in ten minutes. */
const RETRY = 2 * 60_000;

let state: UpdateState = { stage: "idle", current: app.getVersion() };
let offered = "";
let lastCheck = 0;
let timer: NodeJS.Timeout | null = null;
let retry: NodeJS.Timeout | null = null;

// Not a screenshot's offscreen window (capture.ts), which can't show a dialog or hear the state.
const windows = () => BrowserWindow.getAllWindows().filter((w) => !w.webContents.isOffscreen());

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next, current: app.getVersion() };
  for (const w of windows()) w.webContents.send("friday:update-state", state);
}

/**
 * Offer the new version once.
 *
 * Once per version, because the alternative is a dialog that reappears every few minutes in
 * front of whatever someone is doing. After this the page's own row is the way
 * back to it, and the update installs on its own the next time the app quits.
 */
async function offer(version: string): Promise<void> {
  // Once per version: a newer one that follows is worth asking about, the same one again is not.
  if (offered === version) return;
  offered = version;
  const win = windows()[0];
  const opts = {
    type: "info" as const,
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Update ready",
    message: `Friday ${version} is ready to install.`,
    detail: "Restarting takes a moment. If you'd rather finish what you're doing, it installs the next time you quit Friday.",
  };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (response === 0) install();
}

/** Quit and come back on the new version. */
export function install(): void {
  if (state.stage !== "ready") return;
  // isSilent false so the installer shows its progress; isForceRunAfter so the
  // app comes back rather than leaving somebody looking at a closed window.
  autoUpdater.quitAndInstall(false, true);
}

/** Ask the feed now. Safe to call from a button. */
export function check(): UpdateState {
  if (!app.isPackaged) {
    set({ stage: "unsupported", error: "Updates only apply to an installed copy of Friday." });
    return state;
  }
  if (state.stage === "checking" || state.stage === "downloading" || state.stage === "ready") return state;
  lastCheck = Date.now();
  set({ stage: "checking" });
  void autoUpdater.checkForUpdates().catch((e: Error) => set({ stage: "error", error: e.message }));
  return state;
}

export const updateState = (): UpdateState => state;

/**
 * The updater's errors, as sentences.
 *
 * What it throws is a header dump or a signing-framework complaint. Two of
 * them happen often enough to be worth translating, and the rest is at least
 * trimmed to its first line: the whole thing in a settings row is unreadable,
 * and unreadable reads as broken.
 */
function plainly(message: string): string {
  // Squirrel.Mac cannot replace an app it can't verify, so on an unsigned
  // build this is not a hiccup — it is the end of the road.
  if (/code signature|not signed|Could not get code signature/i.test(message))
    return "This copy of Friday isn't signed, so it can't update itself. Download the latest version instead.";
  // GitHub answers 404 both for "no releases yet" and for a private repo it
  // won't discuss with an app carrying no token. Neither is worth a header dump.
  if (/\b404\b/.test(message)) return "No published release to update to yet.";
  return message.split("\n")[0]!.slice(0, 200);
}

export function registerUpdates(): void {
  ipcMain.handle("friday:update-state", () => state);
  ipcMain.handle("friday:update-check", () => check());
  ipcMain.handle("friday:update-install", () => {
    install();
    return true;
  });

  // A checkout has nothing to update, and saying so beats a silent no-op.
  if (!app.isPackaged) {
    state = { stage: "unsupported", error: "Updates only apply to an installed copy of Friday.", current: app.getVersion() };
    return;
  }

  autoUpdater.autoDownload = true;
  // If they never press Restart, the next quit is the next best moment.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => set({ stage: "checking" }));
  autoUpdater.on("update-available", (info: { version: string }) => set({ stage: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => set({ stage: "current", version: undefined, error: undefined }));
  autoUpdater.on("download-progress", (p: { percent: number }) => set({ stage: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    set({ stage: "ready", version: info.version, percent: 100 });
    void offer(info.version);
  });
  autoUpdater.on("error", (e: Error) => set({ stage: "error", error: plainly(e.message) }));

  setTimeout(() => check(), FIRST);
  timer = setInterval(() => check(), EVERY);
  // Looking again when the person comes back, or the computer wakes, is when a new version is most likely to be waiting.
  const soon = () => {
    if (Date.now() - lastCheck >= MIN_GAP) check();
  };
  app.on("browser-window-focus", soon);
  powerMonitor.on("resume", () => setTimeout(soon, 3_000));
  // A failed check tries again shortly instead of waiting out the full interval.
  autoUpdater.on("error", () => {
    if (retry) clearTimeout(retry);
    retry = setTimeout(() => check(), RETRY);
  });
  app.on("before-quit", () => {
    if (timer) clearInterval(timer);
    if (retry) clearTimeout(retry);
  });
}
