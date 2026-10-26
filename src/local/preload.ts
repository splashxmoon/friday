/**
 * The open-source desktop app's bridge to its page (desktop.ts loads it): just what the page needs to lay itself out as the
 * app rather than a browser tab. The page puts its own header where a title bar would be once it knows it's in the app
 * (App.tsx adds the "desktop" classes), and leaves room for the macOS window buttons at the height the window puts them.
 *
 * Nothing here reaches the computer: the page is Friday's own server on 127.0.0.1, and everything else it does goes through
 * that server, as it does in a browser.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("fridayDesktop", {
  platform: process.platform,
  /** Where the macOS window buttons sit (desktop.ts trafficLightPosition), so the page's header lines up with them. */
  trafficLightY: 17,
  /** Which theme the page shows, so Windows and Linux draw the window buttons in its colours. */
  setTheme: (theme: "dark" | "light"): void => ipcRenderer.send("friday:theme", theme),
});
