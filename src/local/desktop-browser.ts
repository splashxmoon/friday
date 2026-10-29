/**
 * The agents' `browser` tool (browser-driver.ts), done by the desktop app: on the session's own Browser panel tab, the one the
 * person watches, when that session is open in the window; else on a page of its own in the background, which nobody sees but the
 * agent (and says so). Both are held to the Preview's cookie jar (persist:preview), never Friday's own.
 *
 * The page tells the app which <webview> is which session's tab as it draws them (preload.ts `browser`, client/Preview.tsx), and
 * is asked to open a tab when an agent needs one there.
 */
import { app, BrowserWindow, ipcMain, session, webContents, type IpcMainEvent, type WebContents } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appAddress, browserKey, readOutput, secretField, setBrowserDriver, webPage, type BrowserAnswer, type BrowserAsk } from "../browser-driver.js";

interface Panel {
  /** The panel's tabs, by the page's own id: each a webview's webContents id. */
  tabs: Map<string, number>;
  active?: string;
}

const panels = new Map<string, Panel>();
// Each agent's own, by browserKey (session and lane): two agents in one session never share a page, its numbers or a wait
// (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
/** The tab each agent last worked in, the panel's or a background page's. */
const used = new Map<string, number>();
/** Each agent's background page, and when it was last used: closed after a while unused (see the sweep below). */
const background = new Map<string, { win: BrowserWindow; at: number }>();
/** Asks for a panel tab, waiting for the page to draw it: the session, and the tabs it had before. One per session at a time (opening). */
const waiting = new Map<string, { before: Set<string>; done: (id: number | null) => void }>();
/** Each session's asks for a panel tab, one after another: the page says only that a tab came, not whose it is. */
const opening = new Map<string, Promise<unknown>>();
/** The pages an agent has driven, each held off Friday's own address and this computer's files. */
const guarded = new WeakSet<WebContents>();
/** Friday's own address (local/desktop.ts), once it is running. */
let appUrl: () => string | null = () => null;
/** A background page unused this long is closed; the next ask makes a new one. */
const IDLE_MS = 15 * 60_000;

const alive = (id: number | undefined): WebContents | null => {
  const wc = id ? webContents.fromId(id) : undefined;
  return wc && !wc.isDestroyed() ? wc : null;
};

/**
 * Friday's own app, by any name for this computer: never loaded in a page an agent drives. The previews' address is
 * http://localhost:<port> beside it (local/start.ts), which answers previews only.
 */
function ownApp(url: string): boolean {
  const at = appUrl();
  if (!at) return false;
  let preview: string | null = null;
  try {
    preview = `http://localhost:${new URL(at).port}`;
  } catch {
    // No address yet: nothing is Friday's.
  }
  return appAddress(url, at, preview);
}

/** Held to the web on its own: no page of Friday's, no file of this computer's, by a link, a script or a redirect. */
function guard(wc: WebContents): void {
  if (guarded.has(wc)) return;
  guarded.add(wc);
  const refuse = (e: { url: string; preventDefault(): void }) => {
    if (ownApp(e.url) || /^file:/i.test(e.url)) e.preventDefault();
  };
  wc.on("will-frame-navigate", refuse);
  wc.on("will-redirect", refuse);
}

/** The page's tabs as it draws them, from Friday's own page only (`fromApp`, desktop.ts). `app`: Friday's own address, once it runs. */
export function registerBrowser(getWin: () => BrowserWindow | null, fromApp: (e: IpcMainEvent) => boolean, appAt: () => string | null): void {
  appUrl = appAt;
  // Every request of the Preview's cookie jar, agent's page or not, to Friday's own address is refused, whatever asked for it (a
  // link, a frame, a script, a redirect at any hop): such a page would be Friday's own origin, trusted with its whole API.
  void app.whenReady().then(() => session.fromPartition("persist:preview").webRequest.onBeforeRequest((d, cb) => cb({ cancel: ownApp(d.url) })));
  // A background page nobody has used for a while is closed, so a session's agents don't keep windows open for good.
  setInterval(() => {
    for (const [key, b] of background) {
      if (b.win.isDestroyed()) background.delete(key);
      else if (Date.now() - b.at > IDLE_MS) {
        b.win.destroy();
        background.delete(key);
      }
    }
  }, 60_000).unref();
  ipcMain.on("friday:browser-tab", (e, sid: unknown, tab: unknown, wcId: unknown) => {
    if (!fromApp(e) || typeof sid !== "string" || typeof tab !== "string") return;
    const p = panels.get(sid) ?? { tabs: new Map<string, number>() };
    panels.set(sid, p);
    if (typeof wcId === "number" && wcId > 0) p.tabs.set(tab, wcId);
    else p.tabs.delete(tab);
    const w = waiting.get(sid);
    if (w && typeof wcId === "number" && wcId > 0 && !w.before.has(tab)) w.done(wcId);
  });
  ipcMain.on("friday:browser-active", (e, sid: unknown, tab: unknown) => {
    if (!fromApp(e) || typeof sid !== "string") return;
    const p = panels.get(sid);
    if (p && typeof tab === "string") p.active = tab;
  });
  ipcMain.on("friday:browser-gone", (e, sid: unknown) => {
    if (fromApp(e) && typeof sid === "string") panels.delete(sid);
  });
  setBrowserDriver({ act: (sid, ask, signal, lane) => act(getWin, sid, lane, ask, signal) });
  // For a check by hand without a coding tool: FRIDAY_BROWSER_DEBUG=1 puts the driver where the main process's inspector reaches it.
  if (process.env.FRIDAY_BROWSER_DEBUG === "1") (globalThis as Record<string, unknown>).fridayBrowser = (sid: string, ask: BrowserAsk, lane?: string) => act(getWin, sid, lane, ask);
}

/** Until the page has stopped loading, or `ms`. */
function settled(wc: WebContents, ms = 12_000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wc.off("did-stop-loading", done);
      setTimeout(resolve, 350);
    }
    if (!wc.isLoading()) return void setTimeout(done, 150);
    wc.once("did-stop-loading", done);
  });
}

/**
 * A tab of the session's panel for an agent, drawn by the page; null when the session isn't open in the window. Asked one at a
 * time per session: the page says only that a new tab came, so two agents asking at once would each take whichever came first.
 */
function panelTab(getWin: () => BrowserWindow | null, sid: string, url: string): Promise<number | null> {
  const asked = (opening.get(sid) ?? Promise.resolve()).then(() => askPanel(getWin, sid, url));
  const settled = asked.catch(() => null);
  opening.set(sid, settled);
  void settled.then(() => opening.get(sid) === settled && opening.delete(sid));
  return asked;
}

function askPanel(getWin: () => BrowserWindow | null, sid: string, url: string): Promise<number | null> {
  const win = getWin();
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const before = new Set(panels.get(sid)?.tabs.keys() ?? []);
    const t = setTimeout(() => finish(null), 6_000);
    const mine = { before, done: finish };
    function finish(id: number | null) {
      clearTimeout(t);
      if (waiting.get(sid) === mine) waiting.delete(sid);
      resolve(id);
    }
    waiting.set(sid, mine);
    win.webContents.send("friday:browser-open", { sid, url });
  });
}

/** The agent's background page (`key`, browserKey), made when first needed. */
function backgroundPage(key: string): WebContents {
  let b = background.get(key);
  if (!b || b.win.isDestroyed()) {
    const w = new BrowserWindow({ show: false, width: 1280, height: 900, paintWhenInitiallyHidden: true, webPreferences: { partition: "persist:preview", sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    // A page's new window opens in its place, and only on the web: never a file of this computer's (file:///…/.ssh/id_rsa,
    // read back by the agent's next read) or Friday's own page.
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (webPage(url) && !ownApp(url)) void w.webContents.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    guard(w.webContents);
    b = { win: w, at: Date.now() };
    background.set(key, b);
  }
  b.at = Date.now();
  return b.win.webContents;
}

/** Whether another agent of the session (`key` is this one's) is working in tab `id`: its page and its numbers are that agent's. */
function anotherHas(sid: string, key: string, id: number): boolean {
  for (const [k, v] of used) if (k !== key && k.startsWith(browserKey(sid, "")) && v === id && alive(v)) return true;
  return false;
}

/** The page this agent works in now: the tab it used last, else the panel's showing tab when no other agent has it, else none yet. */
function current(sid: string, key: string): WebContents | null {
  const last = alive(used.get(key));
  if (last) return last;
  const p = panels.get(sid);
  const shown = p?.active ? alive(p.tabs.get(p.active)) : null;
  if (!shown || anotherHas(sid, key, shown.id)) return null;
  used.set(key, shown.id);
  return shown;
}

const where = (key: string, wc: WebContents) => (background.get(key)?.win.webContents === wc ? " (in the background: this session isn't open in Friday's window, so nobody sees this page but you)" : "");

/** Marks what can be pressed or filled with a number, and says the page as text with them. */
const READ = `(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return (r.width > 0 || r.height > 0) && s.visibility !== "hidden" && s.display !== "none"; };
  document.querySelectorAll("[data-friday-ref]").forEach((el) => el.removeAttribute("data-friday-ref"));
  const els = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=""], [contenteditable=true]')].filter(seen).slice(0, 200);
  const items = els.map((el, i) => {
    el.setAttribute("data-friday-ref", String(i + 1));
    const tag = el.tagName.toLowerCase();
    const kind = tag === "a" ? "link" : tag === "input" ? "field:" + (el.type || "text") : tag === "textarea" ? "field:text" : tag === "select" ? "select" : el.getAttribute("role") || tag;
    const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.name || el.getAttribute("href") || "").replace(/\\s+/g, " ").trim().slice(0, 90);
    const extra = tag === "a" ? " → " + el.href.slice(0, 120) : tag === "input" && el.value && el.type !== "password" ? " = " + String(el.value).slice(0, 60) : "";
    return "[" + (i + 1) + "] " + kind + " " + JSON.stringify(label) + extra;
  });
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { title: document.title, url: location.href, text: text.slice(0, 14000), cut: text.length > 14000, items };
})()`;

const BOX = (ref: number) => `(() => {
  const el = document.querySelector('[data-friday-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height, tag: el.tagName.toLowerCase() };
})()`;

/** What a field says it takes, to refuse typing a secret into it (browser-driver.ts secretField). */
const FIELD = (ref: number) => `(() => {
  const el = document.querySelector('[data-friday-ref="${ref}"]');
  return el ? { type: String(el.type || ""), autocomplete: String(el.autocomplete || el.getAttribute("autocomplete") || ""), name: String(el.name || "") } : null;
})()`;

const KEYS: Record<string, string> = { enter: "Enter", return: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", backspace: "Backspace", delete: "Delete", space: "Space", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", up: "Up", down: "Down", left: "Left", right: "Right", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End" };

function press(wc: WebContents, key: string): void {
  const code = KEYS[key.toLowerCase()] ?? key;
  // Keys go to the page that has focus: a panel tab the person hasn't clicked into has none.
  wc.focus();
  wc.sendInputEvent({ type: "keyDown", keyCode: code });
  if (code === "Enter") wc.sendInputEvent({ type: "char", keyCode: "\r" });
  wc.sendInputEvent({ type: "keyUp", keyCode: code });
}

async function click(wc: WebContents, ref: number): Promise<string | null> {
  const box = (await wc.executeJavaScript(BOX(ref))) as { x: number; y: number; w: number; h: number; tag: string } | null;
  if (!box) return `There's no element ${ref} on the page now: read it again for the current numbers.`;
  if (box.w > 0 && box.h > 0) {
    await new Promise((r) => setTimeout(r, 120));
    wc.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
    wc.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
  } else await wc.executeJavaScript(`document.querySelector('[data-friday-ref="${ref}"]')?.click()`);
  return null;
}

async function act(getWin: () => BrowserWindow | null, sid: string, lane: string | undefined, ask: BrowserAsk, signal?: AbortSignal): Promise<BrowserAnswer> {
  if (signal?.aborted) return { output: "Stopped.", isError: true };
  const key = browserKey(sid, lane);
  const bg = background.get(key);
  if (bg) bg.at = Date.now();
  let wc = current(sid, key);
  if (wc) guard(wc);
  if (ask.action === "open") {
    if (ownApp(ask.url!)) return { output: "That is Friday's own address on this computer: its pages are the person's to use, not a page for an agent's browser.", isError: true };
    if (!wc || ask.new_tab) {
      const id = await panelTab(getWin, sid, ask.url!);
      wc = alive(id ?? undefined) ?? backgroundPage(key);
      guard(wc);
      used.set(key, wc.id);
      // A panel tab is already on its way to the address; a background page is sent there.
      if (!id) void wc.loadURL(ask.url!).catch(() => {});
    } else void wc.loadURL(ask.url!).catch(() => {});
    await settled(wc);
    return { output: `Opened ${wc.getURL()}: “${wc.getTitle()}”${where(key, wc)}. Read it to see what is there.` };
  }
  if (!wc) return { output: "No page is open yet: open one first (action open, with its url).", isError: true };
  switch (ask.action) {
    case "read": {
      const r = (await wc.executeJavaScript(READ)) as { title: string; url: string; text: string; cut: boolean; items: string[] };
      // Fenced as the page's own words (browser-driver.ts readOutput): data from the web, never orders.
      return { output: readOutput(r, where(key, wc)) };
    }
    case "click": {
      const missing = await click(wc, ask.ref!);
      if (missing) return { output: missing, isError: true };
      await settled(wc, 8_000);
      return { output: `Clicked ${ask.ref}. Now on ${wc.getURL()}: “${wc.getTitle()}”. Read it to see what changed.` };
    }
    case "type": {
      // A password, a card's number or code: never typed by an agent, as its instructions say.
      if (secretField((await wc.executeJavaScript(FIELD(ask.ref!))) as { type: string; autocomplete: string; name: string } | null))
        return { output: `Field ${ask.ref} takes a password or a card's details: agents never type those. Ask the person to fill it in themselves.`, isError: true };
      const missing = await click(wc, ask.ref!);
      if (missing) return { output: missing, isError: true };
      // What was in the field goes, so the text is the field's whole value.
      await wc.executeJavaScript(`(() => { const el = document.querySelector('[data-friday-ref="${ask.ref}"]'); if (!el) return; el.focus(); if (typeof el.select === "function") el.select(); else document.execCommand("selectAll"); })()`);
      wc.insertText(ask.text!);
      if (ask.submit) {
        const before = wc.getURL();
        press(wc, "Enter");
        await settled(wc, 3_000);
        // Enter that a page didn't take (a field it never focused): its form is sent as Enter would have sent it.
        if (wc.getURL() === before && !wc.isLoading()) {
          await wc.executeJavaScript(`(() => { const f = document.querySelector('[data-friday-ref="${ask.ref}"]')?.form; if (f) f.requestSubmit ? f.requestSubmit() : f.submit(); })()`);
          await settled(wc, 8_000);
        }
      }
      return { output: `Typed into ${ask.ref}${ask.submit ? ` and pressed Enter. Now on ${wc.getURL()}` : ""}.` };
    }
    case "press":
      press(wc, ask.key!);
      await settled(wc, 5_000);
      return { output: `Pressed ${ask.key}.` };
    case "scroll":
      await wc.executeJavaScript(`window.scrollBy({ top: ${ask.direction === "up" ? -1 : 1} * Math.round(innerHeight * 0.85) })`);
      return { output: `Scrolled ${ask.direction}. Read again to see what is there.` };
    case "back":
      if (!wc.navigationHistory.canGoBack()) return { output: "There's no page before this one.", isError: true };
      wc.navigationHistory.goBack();
      await settled(wc);
      return { output: `Back on ${wc.getURL()}: “${wc.getTitle()}”.` };
    case "screenshot": {
      let img = await wc.capturePage();
      let off = "";
      // A panel tab that isn't showing isn't drawn: the same address is drawn off-screen for the picture.
      if (img.isEmpty() && background.get(key)?.win.webContents !== wc) {
        const bg = backgroundPage(key);
        await bg.loadURL(wc.getURL()).catch(() => {});
        await settled(bg);
        img = await bg.capturePage();
        off = " (drawn off-screen: its tab in the Browser panel isn't showing, so this is the address loaded again)";
      }
      if (img.isEmpty()) return { output: "The page couldn't be drawn for a picture: read it instead.", isError: true };
      if (img.getSize().width > 1400) img = img.resize({ width: 1400 });
      const png = img.toPNG();
      // Kept as a file too, so the agent can show it in the chat by naming it.
      // Under Friday's own folder, not the system's temporary one, which macOS empties: a screenshot shown in the chat stays.
      const dir = path.join(process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday"), "shots");
      const file = path.join(dir, `${sid}-${Date.now()}.png`);
      let saved = "";
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, png);
        saved = ` Saved as ${file}: to show it in the chat, name that file in your message.`;
      } catch {
        // The picture still comes back.
      }
      return { output: "", content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: `${wc.getURL()}${off || where(key, wc)}.${saved}` }] };
    }
  }
  return { output: "That isn't something the browser does.", isError: true };
}
