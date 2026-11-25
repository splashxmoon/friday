import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeBase, clipTargets, encodeScript, GIF_MAX_BYTES, gifTries, walkPage, type ClipMark, type ClipTarget } from "../clip-walk.js";
import { CLIP, mergeErrors, pagesFor, VIEWS, webmWithDuration, type Layout } from "../preview-check.js";
import { reusableServer } from "./dev-servers.js";
import { inWorktreeLine } from "./git.js";
import { listServers } from "./ports.js";
import { previewStatusLive, previewTrouble, startPreview, stopPreview } from "./preview.js";
import { canClipViaDesktop, canScreenshot, capture, clipViaDesktop } from "./screenshot.js";

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

/**
 * The little of playwright-core used here, described rather than imported: the package is a developer's (devDependencies), and the
 * open-source edition's typecheck has none (v0.4.0's release builds failed on `typeof import("playwright-core")`).
 */
interface PwPage {
  on(event: "console", f: (m: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", f: (e: Error) => void): void;
  goto(url: string, o: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForLoadState(state: "networkidle", o: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(js: string): Promise<unknown>;
  screenshot(o: { type: "jpeg"; quality: number; fullPage: boolean; clip: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
  /** A proof clip: navigations off the dev server refused (route), its frames read through Chrome's own screencast (a CDP session). */
  route(match: string, f: (r: { request(): { isNavigationRequest(): boolean; url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => unknown): Promise<void>;
}
interface PwCdp {
  send(method: string, params?: object): Promise<unknown>;
  on(event: "Page.screencastFrame", f: (e: { data: string; sessionId: number }) => void): void;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  newCDPSession(page: PwPage): Promise<PwCdp>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<PwContext>;
  close(): Promise<void>;
}
interface Pw {
  chromium: { launch(o: { headless: boolean; channel?: string }): Promise<PwBrowser> };
}

/** Chrome through playwright-core, when this runner is run from source (a developer's, the test suite): the packaged runner has none. */
async function withBrowser(url: string): Promise<Look> {
  const name = "playwright-core";
  let pw: Pw;
  try {
    pw = (await import(name)) as Pw;
  } catch {
    return { shots: [], errors: [], consoleChecked: false, how: "browser", error: "Screenshots are taken by the Friday desktop app. Open this folder there to check the preview." };
  }
  let browser: PwBrowser | null = null;
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

// ── Proof clips ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Proof clips (Arun, 2026-11-21: "1. Speed baseline, Today with Tonight, and proof clips."; then "i want this proof clips to be very
 * advanced.... and can be toggled on or off"), the runner's half: which words the change added (read from the folder's diff), a walk
 * of the page through them (src/clip-walk.ts), recorded by the desktop app this runner runs under (desktop/capture.ts recordClip) or by
 * Chrome when the runner runs from source; and the same page as it was before the change, from a copy of the code at the commit before
 * it, served by a second dev server for the minute it takes.
 */
export type ClipLabel = "after" | "before" | "phone";
export type Clip =
  | { data: string; mimeType: string; width: number; height: number; durationMs: number; marks: ClipMark[]; errors: string[]; stops: number[]; label: ClipLabel; targets: string[]; /** The same walk as an animated GIF (base64 image/gif, about 800 wide, under 4 MB): absent when it couldn't be made small enough. */ gif?: string; /** The same walk as H.264 in a fast-start MP4 (base64 video/mp4), for an iPhone: from the desktop app only, absent elsewhere. */ mp4?: string }
  | { error: string };
export interface ClipAsk {
  url: string;
  /** The folder and the files the change touched: the words to visit are read from their diff. */
  cwd?: string;
  files?: string[];
  width?: "laptop" | "phone";
  /** Where the "after" clip stopped, for a "before" clip walked to the same places. */
  stops?: number[];
}

const sleep2 = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const git = (cwd: string, args: string[], timeout = 20_000) =>
  new Promise<string>((resolve, reject) =>
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().split("\n")[0])) : resolve(String(out)))),
  );
const gitOr = (cwd: string, args: string[], or: string | null = null) => git(cwd, args).then((s) => s.trim(), () => or);

/** The files that belong to the change, as git names them (relative to the folder), a few hundred at most. */
const cleanFiles = (files: string[] | undefined) => (Array.isArray(files) ? files : []).filter((f) => typeof f === "string" && f && !f.startsWith("-") && !path.isAbsolute(f) && !f.split(/[\\/]/).includes("..")).slice(0, 300);

/** The repository's default branch as this clone knows it: origin's HEAD, else main or master. */
async function defaultBranch(cwd: string): Promise<string | null> {
  const head = await gitOr(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const b of ["origin/main", "origin/master", "main", "master"]) if (await gitOr(cwd, ["rev-parse", "--verify", "--quiet", `${b}^{commit}`])) return b;
  return null;
}

/** The commit the change is compared with (clip-walk.ts beforeBase), and whether the change is still uncommitted. */
async function baseOf(cwd: string, files: string[]): Promise<{ base: string | null; dirty: boolean }> {
  const head = await gitOr(cwd, ["rev-parse", "HEAD"]);
  if (!head) return { base: null, dirty: false };
  const dirty = !!(await gitOr(cwd, ["status", "--porcelain", "--", ...(files.length ? files : ["."])], ""));
  const main = dirty ? null : await defaultBranch(cwd);
  const mergeBase = main ? await gitOr(cwd, ["merge-base", "HEAD", main]) : null;
  const parent = dirty ? null : await gitOr(cwd, ["rev-parse", "--verify", "--quiet", "HEAD~1"]);
  return { base: beforeBase({ dirty, head, mergeBase, parent }), dirty };
}

/** The words the change added to the page: its diff against the commit before it, for the files it touched (new files included). */
export async function changedWords(cwd: string, files: string[]): Promise<ClipTarget[]> {
  const list = cleanFiles(files);
  if (!list.length || !existsSync(cwd)) return [];
  const { base } = await baseOf(cwd, list);
  if (!base) return [];
  let diff = (await git(cwd, ["diff", "--no-color", "--no-ext-diff", "-U0", base, "--", ...list]).catch(() => "")) || "";
  // A file the change made and git doesn't know yet is all new: read as an addition.
  const untracked = (await gitOr(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...list], "")) ?? "";
  for (const f of untracked.split("\n").filter(Boolean).slice(0, 20)) {
    const text = await readFile(path.join(cwd, f), "utf8").catch(() => "");
    if (text && text.length < 400_000) diff += `\n+++ b/${f}\n` + text.split("\n").map((l) => `+${l}`).join("\n");
  }
  return clipTargets(diff);
}

type Recorded = { data: string; mimeType: string; width: number; height: number; durationMs: number; marks: ClipMark[]; errors: string[]; stops: number[]; gif?: string; mp4?: string } | { error: string };

/** A walked clip through Chrome, when this runner is run from source (a developer's, the test suite): its screencast, then the same making. */
async function clipWithBrowser(url: string, width: number, height: number, walk: { targets: ClipTarget[]; stops?: number[]; badge?: string }): Promise<Recorded> {
  const name = "playwright-core";
  let pw: Pw;
  try {
    pw = (await import(name)) as Pw;
  } catch {
    return { error: "Clips are recorded by the Friday desktop app. Open this folder there to record one." };
  }
  let browser: PwBrowser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true, ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}) });
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const origin = new URL(url).origin;
    // A press never takes the page off this app.
    await page.route("**/*", (r) => (r.request().isNavigationRequest() && new URL(r.request().url()).origin !== origin ? r.abort() : r.continue()));
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.length < 20 && errors.push(m.text()));
    page.on("pageerror", (e) => errors.length < 20 && errors.push(e.message));
    await page.goto(url, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    const frames: [number, string][] = [];
    const cdp = await ctx.newCDPSession(page);
    let t0 = Date.now();
    cdp.on("Page.screencastFrame", (f) => {
      frames.push([Date.now() - t0, f.data]);
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    t0 = Date.now();
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    const walked = await walkPage({ run: (js) => page.evaluate(js) as Promise<never>, sleep: sleep2, now: Date.now }, { t0, width, height, targets: walk.targets, ...(walk.stops ? { stops: walk.stops } : {}) });
    await cdp.send("Page.stopScreencast").catch(() => {});
    if (!frames.length) return { error: "Chrome drew nothing to record." };
    if (frames[0]![0] > 0) frames[0]![0] = 0;
    // Made in a blank page of its own: nothing of the app's runs while the clip is made.
    const maker = await ctx.newPage();
    // The GIF is made once, with the first video: a lighter video doesn't change it.
    let gif: string | undefined;
    for (const bitrate of [2_500_000, 1_200_000, 600_000]) {
      await maker.evaluate("window.__fridayClip = []; 0");
      for (let i = 0; i < frames.length; i += 20) await maker.evaluate(`window.__fridayClip.push(...${JSON.stringify(frames.slice(i, i + 20))}); 0`);
      const out = (await maker.evaluate(encodeScript({ width, height, durationMs: walked.durationMs, fps: CLIP.fps, bitrate, beats: walked.beats, ...(walk.badge ? { badge: walk.badge } : {}), ...(gif === undefined ? { gif: { tries: gifTries(width, height), maxBytes: GIF_MAX_BYTES } } : {}) }))) as { data?: string; gif?: string; error?: string };
      if (gif === undefined) gif = out?.gif ?? "";
      if (!out?.data) return { error: out?.error || "The clip couldn't be made." };
      if ((out.data.length * 3) / 4 > CLIP.maxBytes && bitrate !== 600_000) continue;
      const data = Buffer.from(webmWithDuration(Buffer.from(out.data, "base64"), walked.durationMs)).toString("base64");
      return { data, mimeType: "video/webm", width, height, durationMs: walked.durationMs, marks: walked.marks, errors, stops: walked.stops, ...(gif ? { gif } : {}) };
    }
    return { error: "The clip couldn't be made." };
  } catch (e) {
    return { error: `Couldn't record the page: ${(e as Error).message.split("\n")[0]}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** One recording, by the desktop app when it can, else Chrome; the size from VIEWS (a laptop's, or a phone's). */
async function record(url: string, width: "laptop" | "phone", walk: { targets: ClipTarget[]; stops?: number[]; badge?: string }): Promise<Recorded> {
  const v = VIEWS[width === "phone" ? 1 : 0];
  if (canClipViaDesktop()) {
    const d = await clipViaDesktop({ url, width: v.width, height: v.height, targets: walk.targets, ...(walk.stops ? { stops: walk.stops } : {}), ...(walk.badge ? { badge: walk.badge } : {}) });
    if (!d.data) return { error: d.error || "The clip couldn't be made." };
    return { data: d.data, mimeType: d.mimeType || "video/webm", width: d.width ?? v.width, height: d.height ?? v.height, durationMs: d.durationMs ?? 0, marks: d.marks ?? [], errors: d.errors ?? [], stops: d.stops ?? [], ...(d.gif ? { gif: d.gif } : {}), ...(d.mp4 ? { mp4: d.mp4 } : {}) };
  }
  // A desktop app too old to record clips takes the screenshots but can't make one; a runner from source has Chrome.
  if (canScreenshot()) return { error: "Clips are recorded by a newer Friday desktop app. Update it to record one." };
  return clipWithBrowser(url, v.width, v.height, walk);
}

const localPage = (url: string): URL | null => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && LOCAL.test(u.hostname) ? u : null;
  } catch {
    return null;
  }
};

/**
 * A proof clip of one page of the running app: with the folder and the files the change touched, a walk through the words it added
 * (scrolled to, pointed at, ringed and captioned, the pressable ones pressed); without, or with none on the page, the page scrolled
 * through. At a laptop's width, or a phone's when asked. Never throws: what went wrong is in `error`.
 */
export async function clipPage(ask: ClipAsk | string): Promise<Clip> {
  const a: ClipAsk = typeof ask === "string" ? { url: ask } : ask;
  const u = localPage(String(a.url ?? ""));
  if (!u) return { error: "Only a page served on this computer (localhost) can be recorded." };
  const width = a.width === "phone" ? "phone" : "laptop";
  const targets = a.cwd ? await changedWords(a.cwd, a.files ?? []).catch(() => []) : [];
  const stops = Array.isArray(a.stops) ? a.stops.filter((y) => Number.isFinite(y)).slice(0, 3) : undefined;
  const r = await record(u.toString(), width, { targets, ...(stops && !targets.length ? { stops } : {}) });
  return "error" in r ? r : { ...r, label: width === "phone" ? "phone" : "after", targets: targets.map((t) => t.text) };
}

/** The longest a "before" clip may take, all of it (the copy, its server, the walk): past this it says so rather than hanging. */
export const BEFORE_CAP_MS = 150_000;

/**
 * The page as it was before the change, walked the same way: a copy of the code at the commit before the change (an uncommitted
 * change: the last commit; a branch: where it left the default branch), made as a git worktree under the system's temp folder, with the
 * folder's node_modules linked in (a junction on Windows) and its .env files copied, served by its own dev server started as the
 * Preview starts one, recorded at the same page with "Before" in the corner, then the server stopped and the copy removed.
 */
export async function clipBefore(ask: ClipAsk): Promise<Clip> {
  const u = localPage(String(ask.url ?? ""));
  if (!u) return { error: "Only a page served on this computer (localhost) can be recorded." };
  const cwd = String(ask.cwd ?? "");
  if (!cwd || !path.isAbsolute(cwd) || !existsSync(cwd)) return { error: "The before clip needs the project's folder." };
  const width = ask.width === "phone" ? "phone" : "laptop";
  const stops = Array.isArray(ask.stops) ? ask.stops.filter((y) => Number.isFinite(y)).slice(0, 3) : [];
  let timer: NodeJS.Timeout | undefined;
  const capped = new Promise<Clip>((r) => (timer = setTimeout(() => r({ error: "The page before the change took too long to start (over two and a half minutes)." }), BEFORE_CAP_MS)));
  try {
    return await Promise.race([beforeWork(cwd, u, width, cleanFiles(ask.files), stops), capped]);
  } finally {
    clearTimeout(timer);
  }
}

async function beforeWork(cwd: string, u: URL, width: "laptop" | "phone", files: string[], stops: number[]): Promise<Clip> {
  const root = await gitOr(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { error: "This folder isn't a git repository, so there's no before to show." };
  const { base } = await baseOf(cwd, files);
  if (!base) return { error: "There's nothing before this change to compare with (it's the first commit)." };
  // Where the folder sits in its repository, read through links on both sides (git names the repository by its real path: on a Mac,
  // /var is /private/var). Anything but a folder inside it is refused, so the copy's server can never be the folder's own.
  const rel = path.relative(await realpath(root).catch(() => root), await realpath(cwd).catch(() => cwd));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: "This folder isn't inside its git repository as expected, so there's no before to show." };
  const tmp = await mkdtemp(path.join(os.tmpdir(), "friday-before-"));
  const copy = path.join(tmp, "app");
  const folder = rel ? path.join(copy, rel) : copy;
  let added = false;
  try {
    await inWorktreeLine(root, () => git(root, ["worktree", "add", "--detach", "--force", copy, base], 120_000));
    added = true;
    // What the copy needs to run and git doesn't hold: the installed packages (linked, not copied) and the folder's .env files.
    const link = async (from: string, to: string) => {
      if (existsSync(from) && !existsSync(to)) await symlink(from, to, process.platform === "win32" ? "junction" : "dir").catch(() => {});
    };
    await link(path.join(cwd, "node_modules"), path.join(folder, "node_modules"));
    if (rel) await link(path.join(root, "node_modules"), path.join(copy, "node_modules"));
    for (const f of await readdir(cwd).catch(() => [] as string[])) if (/^\.env(\..+)?$/.test(f) && !existsSync(path.join(folder, f))) await copyFile(path.join(cwd, f), path.join(folder, f)).catch(() => {});
    let info;
    try {
      info = await startPreview(folder);
    } catch (e) {
      return { error: `The page before the change couldn't be served: ${previewTrouble((e as Error).message).split("\n")[0]}` };
    }
    for (let i = 0; i < 120 && !info.ready; i++) {
      await sleep2(500);
      const now = await previewStatusLive(folder);
      if (!now) return { error: `The page before the change couldn't be served: ${info.command} stopped before serving anything.` };
      info = now;
    }
    if (!info.ready) return { error: "The page before the change didn't come up in time." };
    const at = new URL(u.pathname + u.search, info.url).toString();
    const r = await record(at, width, { targets: [], stops, badge: "Before" });
    return "error" in r ? r : { ...r, label: "before", targets: [] };
  } finally {
    stopPreview(folder);
    // Windows lets go of a folder only once the server's processes are gone (taskkill is on its way).
    if (process.platform === "win32") await sleep2(1500);
    if (added) await inWorktreeLine(root, () => git(root, ["worktree", "remove", "--force", copy], 60_000)).catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    await inWorktreeLine(root, () => gitOr(root, ["worktree", "prune"]));
  }
}
