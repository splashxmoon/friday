import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mergeErrors, pagesFor, VIEWS, type Layout } from "../preview-check.js";
import { reusableServer } from "./dev-servers.js";
import { listServers } from "./ports.js";
import { previewStatusLive, previewTrouble, startPreview } from "./preview.js";
import { canScreenshot, capture } from "./screenshot.js";

/**
 * Preview checks, the runner's half (Arun, 2026-11-19, wave 3: "after a change, Friday opens the app's preview, clicks through what
 * changed and shows you screenshots before you look."): `plan` says which pages a run's files are and where the project's dev server
 * answers (starting it when nothing does, the same way the Preview's own start does), and `look` takes one page at a laptop's width and
 * a phone's with what it logged as errors. The page calls them in turn, so each call is short enough for a linked computer's 30 seconds.
 */

export interface CheckPlan {
  pages: string[];
  /** Where the dev server answers; null while it is still coming up, or when there is none to be had. */
  url: string | null;
  starting?: boolean;
  /** "npm run dev", for the line that says what was started. */
  started?: string;
  error?: string;
}

async function layoutOf(cwd: string): Promise<Layout> {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
    for (const k of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) deps.add(k);
  } catch {}
  return { deps, has: (p) => existsSync(path.join(cwd, ...p.split("/"))) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether a folder is `cwd` or one of its subfolders (a sibling copy of the repo, or a parent, is not). */
const within = (cwd: string, folder: string | null): boolean => {
  if (!folder) return false;
  const rel = path.relative(path.resolve(cwd), path.resolve(folder));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Of the servers running here, the one to photograph: one started inside this folder (not in another agent's copy of the repo, which
 * lacks this run's change) whose "/" answers with a page (not an API's JSON or "Cannot GET /"), the lowest port first. Null when none is.
 */
export async function pickServer(servers: ReadonlyArray<{ port: number; cwd: string | null; here: boolean }>, cwd: string, servesPage: (port: number) => Promise<boolean>): Promise<number | null> {
  for (const s of [...servers].sort((a, b) => a.port - b.port)) {
    if (s.here && within(cwd, s.cwd) && (await servesPage(s.port))) return s.port;
  }
  return null;
}

/** Whether "/" on this port answers 2xx or 3xx with html. */
async function servesHtml(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/`, { redirect: "manual", headers: { accept: "text/html" }, signal: AbortSignal.timeout(3000) });
    await r.body?.cancel().catch(() => {});
    return r.status >= 200 && r.status < 400 && /html/i.test(r.headers.get("content-type") ?? "");
  } catch {
    return false;
  }
}

/** A guessed page that answers 404 (or not at all) is no page of this app: the pictures would be of an error. */
async function pageThere(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(8000) });
    await r.body?.cancel().catch(() => {});
    return r.status !== 404 && r.status !== 410;
  } catch {
    return false;
  }
}

/** The pages that exist: the guessed ones that don't answer are dropped, and "/" stands in when none do. */
async function existing(base: string, pages: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const p of pages) if (p === "/" || (await pageThere(base.replace(/\/$/, "") + p))) kept.push(p);
  return kept.length ? kept : ["/"];
}

/** Friday's own running preview of the folder, else a server of this project that serves a page, else a start of the preview. */
export async function planCheck(cwd: string, files: string[]): Promise<CheckPlan> {
  const guessed = pagesFor(files.slice(0, 500), await layoutOf(cwd));
  let info = await previewStatusLive(cwd);
  if (info?.ready) return { pages: await existing(info.url, guessed), url: info.url };
  if (!info) {
    // The server Friday keeps for this folder (dev-servers.ts), up or on its way back up, is the one to look at: no second one is started
    // (Arun, 2026-11-19, wave 4: "When an agent's run wants a server… reuse the running one instead of starting another").
    const kept = await reusableServer(cwd, 15_000);
    if (kept && (await servesHtml(kept.port))) return { pages: await existing(kept.url, guessed), url: kept.url };
    const port = await pickServer(await listServers(cwd), cwd, servesHtml);
    if (port) {
      const url = `http://localhost:${port}`;
      return { pages: await existing(url, guessed), url };
    }
  }
  const pages = guessed;
  let started: string | undefined;
  if (!info) {
    try {
      info = await startPreview(cwd);
      started = info.command;
    } catch (e) {
      return { pages, url: null, error: previewTrouble((e as Error).message) };
    }
  }
  // Starting waited for it already (up to a minute: a linked computer's call may give up first, and the page asks again, finding it
  // here). One already on its way gets a few seconds; past those the page is told it is still starting and asks again.
  for (let i = 0; i < 20 && !info.ready; i++) {
    await sleep(500);
    const now = await previewStatusLive(cwd);
    if (!now) return { pages, url: null, error: previewTrouble(`${info.command} stopped before serving anything.\n${info.log.slice(-6).join("\n")}`) };
    info = now;
  }
  if (info.ready) return { pages: await existing(info.url, pages), url: info.url, ...(started ? { started } : {}) };
  return { pages, url: null, starting: true, ...(started ? { started } : {}) };
}

export interface LookShot {
  label: string;
  width: number;
  height: number;
  mimeType: string;
  /** base64 */
  data: string;
  /** A page taller than the picture goes on below it. */
  cut?: boolean;
}

export interface Look {
  shots: LookShot[];
  errors: string[];
  /** Whether the page's console was read at all: an older desktop app takes the pictures but can't say. */
  consoleChecked: boolean;
  how: "desktop" | "browser";
  error?: string;
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
/** The tallest page drawn whole: taller is cut there, as preview_screenshot's (desktop/capture.ts). */
const MAX_PAGE = 4000;

/** Chrome through playwright-core, when this runner is run from source (a developer's, the test suite): the packaged runner has none. */
async function withBrowser(url: string): Promise<Look> {
  const name = "playwright-core";
  let pw: typeof import("playwright-core");
  try {
    pw = (await import(name)) as typeof import("playwright-core");
  } catch {
    return { shots: [], errors: [], consoleChecked: false, how: "browser", error: "Screenshots are taken by the Friday desktop app. Open this folder there to check the preview." };
  }
  let browser: import("playwright-core").Browser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true, ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}) });
    const shots: LookShot[] = [];
    const lists: string[][] = [];
    for (const v of VIEWS) {
      const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errs: string[] = [];
      page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
      page.on("pageerror", (e) => errs.push(e.message));
      await page.goto(url, { waitUntil: "load", timeout: 30_000 }).catch((e: Error) => errs.push(`The page didn't load: ${e.message.split("\n")[0]}`));
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      const tall = await page.evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)").then(Number, () => v.height);
      const h = Math.max(v.height, Math.min(tall || v.height, MAX_PAGE));
      const png = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true, clip: { x: 0, y: 0, width: v.width, height: h } });
      shots.push({ label: v.label, width: v.width, height: h, mimeType: "image/jpeg", data: png.toString("base64"), ...(tall > MAX_PAGE ? { cut: true } : {}) });
      lists.push(errs);
      await ctx.close();
    }
    return { shots, errors: mergeErrors(lists), consoleChecked: true, how: "browser" };
  } catch (e) {
    return { shots: [], errors: [], consoleChecked: false, how: "browser", error: `Couldn't open a browser: ${(e as Error).message.split("\n")[0]}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** One page of the running app, at each width, with its console errors. Never throws: what went wrong is in `error`. */
export async function lookAtPage(url: string): Promise<Look> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { shots: [], errors: [], consoleChecked: false, how: "desktop", error: "That isn't a page address." };
  }
  if (!/^https?:$/.test(u.protocol) || !LOCAL.test(u.hostname)) return { shots: [], errors: [], consoleChecked: false, how: "desktop", error: "Only a page served on this computer (localhost) can be checked." };
  if (!canScreenshot()) return withBrowser(u.toString());
  const shots: LookShot[] = [];
  const lists: string[][] = [];
  let checked = true;
  for (const v of VIEWS) {
    const d = await capture({ url: u.toString(), width: v.width, height: v.height, fullPage: true, console: true });
    if (!d.data) return { shots, errors: mergeErrors(lists), consoleChecked: false, how: "desktop", error: d.error || "The screenshot couldn't be taken." };
    shots.push({ label: v.label, width: d.width ?? v.width, height: d.height ?? v.height, mimeType: d.mimeType || "image/png", data: d.data, ...(d.cut ? { cut: true } : {}) });
    if (Array.isArray(d.errors)) lists.push(d.errors);
    else checked = false;
  }
  return { shots, errors: mergeErrors(lists), consoleChecked: checked, how: "desktop" };
}
