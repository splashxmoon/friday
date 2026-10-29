/**
 * The open-source desktop app's bridge to its page (desktop.ts loads it): just what the page needs to lay itself out as the
 * app rather than a browser tab. The page puts its own header where a title bar would be once it knows it's in the app
 * (App.tsx adds the "desktop" classes), and leaves room for the macOS window buttons at the height the window puts them.
 *
 * Nothing here reaches the computer: the page is Friday's own server on 127.0.0.1, and everything else it does goes through
 * that server, as it does in a browser.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("fridayDesktop", {
  platform: process.platform,
  /** Where the macOS window buttons sit (desktop.ts trafficLightPosition), so the page's header lines up with them. */
  trafficLightY: 17,
  /** Which theme the page shows, so Windows and Linux draw the window buttons in its colours. */
  /** `choice` is what was picked, System included, so the app's own sheets follow it (desktop.ts nativeTheme). */
  setTheme: (theme: "dark" | "light", choice?: "system" | "dark" | "light"): void => ipcRenderer.send("friday:theme", theme, choice),
  /** Open a folder, or a file at a line, in this computer's own editor, file manager or terminal (desktop-native.ts). */
  openTargets: (): Promise<{ id: string; label: string; editor: boolean }[]> => ipcRenderer.invoke("friday:open-targets"),
  openIn: (target: string, path: string, line?: number): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("friday:open-in", { target, path, line }),
  openFile: (file: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("friday:open-file", file),
  /** The agents' browser (desktop-browser.ts): which webview is which session's tab, and a tab opened when an agent needs one. */
  browser: {
    tab: (sid: string, tab: string, wcId: number): void => ipcRenderer.send("friday:browser-tab", sid, tab, wcId),
    active: (sid: string, tab: string): void => ipcRenderer.send("friday:browser-active", sid, tab),
    gone: (sid: string): void => ipcRenderer.send("friday:browser-gone", sid),
    onOpen: (fn: (ask: { sid: string; url: string }) => void): (() => void) => {
      const h = (_e: unknown, ask: { sid: string; url: string }) => fn(ask);
      ipcRenderer.on("friday:browser-open", h);
      return () => void ipcRenderer.off("friday:browser-open", h);
    },
  },
  /** How many things wait on you, on the dock icon; 0 clears it. */
  setBadge: (n: number): void => ipcRenderer.send("friday:badge", n),
  /** The system's folder picker, for where a coding agent works. */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("friday:pick-folder"),
  /** Where a file or folder dropped on the page is on this computer. */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** Real shells on this computer for the terminal panel (desktop-terminal.ts), keyed by an id the page chooses. */
  terminal: {
    start: (opts: { id: string; cols: number; rows: number; cwd?: string }): Promise<{ ok: boolean; shell?: string; cwd?: string; resumed?: boolean; replay?: string; error?: string }> =>
      ipcRenderer.invoke("friday:pty-start", opts),
    write: (id: string, data: string): void => ipcRenderer.send("friday:pty-write", id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send("friday:pty-resize", id, { cols, rows }),
    kill: (id: string): void => ipcRenderer.send("friday:pty-kill", id),
    onData: (fn: (id: string, data: string) => void): (() => void) => {
      const h = (_e: unknown, id: string, d: string) => fn(id, d);
      ipcRenderer.on("friday:pty-data", h);
      return () => void ipcRenderer.off("friday:pty-data", h);
    },
    onExit: (fn: (id: string, code: number) => void): (() => void) => {
      const h = (_e: unknown, id: string, c: number) => fn(id, c);
      ipcRenderer.on("friday:pty-exit", h);
      return () => void ipcRenderer.off("friday:pty-exit", h);
    },
  },
  /** Its updates (desktop-update.ts): the version it is, whether a newer one is downloading or ready, and the restart into it. */
  update: {
    state: (): Promise<unknown> => ipcRenderer.invoke("friday:update-state"),
    check: (): Promise<unknown> => ipcRenderer.invoke("friday:update-check"),
    install: (): Promise<boolean> => ipcRenderer.invoke("friday:update-install"),
    onState: (fn: (s: unknown) => void): (() => void) => {
      const h = (_e: unknown, s: unknown) => fn(s);
      ipcRenderer.on("friday:update-state", h);
      return () => void ipcRenderer.off("friday:update-state", h);
    },
  },
});
