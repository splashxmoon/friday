import { BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, Tray } from "electron";
import { TRAY_ICONS } from "./tray-icons.js";

/**
 * Friday in the menu bar (Arun, 2026-11-16: the menu bar mock, "This is good", then "Ok"): the Friday mark, how many agents are
 * working beside it, an amber dot on it when one needs you; pressed, a panel under it to answer what waits, watch what runs and
 * start a task without opening Friday. The panel is the app's own page in a bare view (?view=tray, TrayPanel.tsx), loaded once
 * and kept, hidden, so it keeps reading how things stand and the mark is right before it is ever opened.
 */

const WIDTH = 400;
const MAX_HEIGHT = 640;

const image = (one: string, two: string, template: boolean) => {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: Buffer.from(one, "base64") });
  img.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(two, "base64") });
  if (template) img.setTemplateImage(true);
  return img;
};

export function registerTray(deps: {
  /** Friday's address, once it is running. */
  origin: () => string | null;
  preload: string;
  /** Brings the main window forward, opening it if it was closed. */
  showMain: () => BrowserWindow | null;
  trusted: (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean;
}): { start: () => void } {
  // The Mac's menu bar only: Windows' tray and Linux's are other furniture, with other habits, for another day.
  if (process.platform !== "darwin") return { start: () => {} };
  const icons = {
    plain: image(TRAY_ICONS.template, TRAY_ICONS.template2x, true),
    needsDark: image(TRAY_ICONS.needsDark, TRAY_ICONS.needsDark2x, false),
    needsLight: image(TRAY_ICONS.needsLight, TRAY_ICONS.needsLight2x, false),
  };
  let state = { working: 0, needs: 0 };
  let tray: Tray | null = null;
  let panel: BrowserWindow | null = null;
  let height = 420;
  // Shown, then hidden by the press on the mark that would show it again: blur fires first, so that press would reopen it.
  let hiddenAt = 0;
  // A picker's menu is open over the panel (friday:tray-menu below).
  let menuOpen = false;

  const paint = () => {
    if (!tray) return;
    tray.setImage(state.needs ? (nativeTheme.shouldUseDarkColors ? icons.needsDark : icons.needsLight) : icons.plain);
    // The count beside the mark, in the menu bar's own type: nothing at all when nothing runs.
    tray.setTitle(state.working ? String(state.working) : "", { fontType: "monospacedDigit" });
    tray.setToolTip(state.needs ? `Friday · ${state.needs} need${state.needs === 1 ? "s" : ""} you` : state.working ? `Friday · ${state.working} working` : "Friday");
  };

  const place = () => {
    if (!tray || !panel) return;
    const b = tray.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - WIDTH / 2, d.workArea.x + 8), d.workArea.x + d.workArea.width - WIDTH - 8));
    const y = Math.round(b.y + b.height + 6);
    panel.setBounds({ x, y, width: WIDTH, height: Math.min(height, MAX_HEIGHT, d.workArea.height - 24) });
  };

  const make = () => {
    const origin = deps.origin();
    if (!origin) return null;
    const w = new BrowserWindow({
      width: WIDTH,
      height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      title: "Friday",
      backgroundColor: "#00000000",
      transparent: true,
      vibrancy: "popover",
      visualEffectState: "active",
      roundedCorners: true,
      webPreferences: { contextIsolation: true, sandbox: true, preload: deps.preload, backgroundThrottling: false },
    });
    w.setAlwaysOnTop(true, "pop-up-menu");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.on("blur", () => {
      // A picker's menu open over it takes the focus for a moment: the panel stays.
      if (!w.isVisible() || menuOpen) return;
      hiddenAt = Date.now();
      w.hide();
    });
    w.on("closed", () => {
      if (panel === w) panel = null;
    });
    // Its links and pages go to the main window or the person's browser, never into the panel itself.
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    void w.loadURL(`${origin}/?view=tray`);
    return w;
  };

  const toggle = () => {
    if (panel?.isVisible()) return panel.hide();
    if (Date.now() - hiddenAt < 250) return;
    panel ??= make();
    if (!panel) return;
    place();
    panel.show();
    panel.focus();
    panel.webContents.send("friday:tray-shown");
  };

  const fromPanel = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => !!panel && e.sender === panel.webContents && deps.trusted(e);

  // How things stand, from the panel's page as it reads them: the mark and its count follow.
  ipcMain.on("friday:tray-state", (e, working: unknown, needs: unknown) => {
    if (!fromPanel(e)) return;
    state = { working: Math.max(0, Math.min(99, Number(working) || 0)), needs: Math.max(0, Math.min(99, Number(needs) || 0)) };
    paint();
  });
  // As tall as what it shows, up to MAX_HEIGHT; it scrolls past that.
  ipcMain.on("friday:tray-size", (e, h: unknown) => {
    if (!fromPanel(e)) return;
    const next = Math.max(160, Math.min(MAX_HEIGHT, Math.round(Number(h) || 0)));
    if (next === height) return;
    height = next;
    if (panel?.isVisible()) place();
  });
  // A picker in the panel (which project, which coding tool) as the Mac's own menu, under the button that asked: drawn by the
  // system, so it floats over everything and is never cut to the panel's own height, as a menu drawn in the page was.
  ipcMain.handle("friday:tray-menu", (e, items: unknown, at: unknown) => {
    if (!fromPanel(e) || !panel || !Array.isArray(items)) return null;
    const list = items.slice(0, 40).flatMap((it) => {
      const i = (it ?? {}) as { id?: unknown; label?: unknown; sub?: unknown; checked?: unknown };
      return typeof i.id === "string" && typeof i.label === "string" ? [{ id: i.id.slice(0, 400), label: i.label.slice(0, 80), ...(typeof i.sub === "string" ? { sub: i.sub.slice(0, 120) } : {}), checked: i.checked === true }] : [];
    });
    const p = (at ?? {}) as { x?: unknown; y?: unknown };
    return new Promise<string | null>((resolve) => {
      let done = false;
      const end = (v: string | null) => {
        if (done) return;
        done = true;
        menuOpen = false;
        resolve(v);
      };
      menuOpen = true;
      Menu.buildFromTemplate(list.map((i) => ({ label: i.label, ...(i.sub ? { sublabel: i.sub } : {}), type: "checkbox" as const, checked: i.checked, click: () => end(i.id) }))).popup({
        window: panel!,
        x: Math.round(Number(p.x) || 0),
        y: Math.round(Number(p.y) || 0),
        // Closed without a choice; a choice's click comes first, so this is only the miss.
        callback: () => setTimeout(() => end(null), 50),
      });
    });
  });
  ipcMain.on("friday:tray-hide", (e) => {
    if (fromPanel(e)) panel?.hide();
  });
  // A session, or the Needs you page, in the main window: the panel goes, the window comes forward on it.
  ipcMain.on("friday:tray-open", (e, where: unknown) => {
    if (!fromPanel(e)) return;
    panel?.hide();
    const main = deps.showMain();
    if (!main) return;
    const w = (where ?? {}) as { sid?: unknown; invite?: unknown; view?: unknown };
    const detail = typeof w.sid === "string" ? { sid: w.sid.slice(0, 80), ...(typeof w.invite === "string" ? { invite: w.invite.slice(0, 2000) } : {}) } : null;
    const view = w.view === "needs" ? "needs" : null;
    const go = () =>
      void main.webContents
        .executeJavaScript(detail ? `dispatchEvent(new CustomEvent("friday:open-session", { detail: ${JSON.stringify(detail)} }))` : view ? `dispatchEvent(new Event("friday:open-needs"))` : "void 0")
        .catch(() => {});
    if (main.webContents.isLoading()) main.webContents.once("did-finish-load", go);
    else go();
  });

  nativeTheme.on("updated", paint);

  /** Called once Friday is running: the mark goes up, and the panel's page starts reading. */
  const start = () => {
    if (tray) return;
    tray = new Tray(icons.plain);
    tray.setIgnoreDoubleClickEvents(true);
    paint();
    tray.on("click", toggle);
    tray.on("right-click", () =>
      tray?.popUpContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Friday", click: () => void deps.showMain() },
          { type: "separator" },
          { label: "Quit Friday", role: "quit" },
        ]),
      ),
    );
    panel ??= make();
  };
  return { start };
}
