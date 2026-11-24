// preview_screenshot's picture (src/agent-mesh.ts, src/runner/screenshot.ts): a page on this computer, drawn in an offscreen
// window of this app's own process and captured. Nothing opens and nothing new shows in the Dock, where each headless Chrome a
// coding tool launched to look at its page put a second Chrome (Arun, 2026-10-19). Offscreen windows draw at 1x, so the picture is
// the size asked for, not twice it on a Retina screen, which is all a model reads anyway.
import { BrowserWindow, nativeImage, session, type NativeImage } from "electron";
import { encodeScript, GIF_MAX_BYTES, gifTries, walkPage, type ClipMark, type ClipTarget } from "./clip-walk.js";
import { fastStartMp4 } from "./mp4-faststart.js";
import { CLIP, webmWithDuration } from "./preview-check.js";

export interface CaptureAsk {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  /** Also report the page's console errors (a preview check, src/preview-check.ts). */
  console?: boolean;
}

/** `cut`: a whole page taller than MAX_PAGE, captured down to there. */
export type CaptureResult = { data: string; mimeType: string; width: number; height: number; cut?: boolean; errors?: string[] } | { error: string };

/** The tallest whole page captured: taller is cut there (a model shrinks a picture that long until it can't read it anyway). */
const MAX_PAGE = 4000;
/** Over this a PNG goes as a JPEG: Claude takes at most 5 MB a picture. */
const MAX_PNG = 3_500_000;

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
const clamp = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Its own session, in memory: no cookies or storage shared with Friday's window, and nothing a page asks for is granted. */
function shots() {
  const s = session.fromPartition("friday-screenshots");
  s.setPermissionRequestHandler((_wc, _p, grant) => grant(false));
  return s;
}

export async function capturePreview(ask: CaptureAsk): Promise<CaptureResult> {
  let url: URL;
  try {
    url = new URL(String(ask.url));
  } catch {
    return { error: "Give the page's address, e.g. http://localhost:5173/." };
  }
  // Only this computer's pages, whatever asked: the server checks too.
  if (!/^https?:$/.test(url.protocol) || !LOCAL.test(url.hostname)) return { error: "Only a page served on this machine (localhost) can be captured." };
  const width = clamp(ask.width, 1280, 320, 2560);
  const height = clamp(ask.height, 900, 240, 2000);
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: shots(), backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  // What the page logs as an error while it loads and draws, for a preview check (Arun, 2026-11-19: "shows you screenshots before
  // you look"). Electron's event carries the level as a word since 35 and as a number before; an uncaught exception arrives as one.
  const errors: string[] = [];
  if (ask.console) {
    wc.on("console-message", (...a: unknown[]) => {
      const d = a[0] as { level?: unknown; message?: unknown };
      const level = typeof d?.level === "string" ? d.level : a[1] === 3 ? "error" : "";
      const message = typeof d?.message === "string" ? d.message : typeof a[2] === "string" ? a[2] : "";
      if (level === "error" && message && errors.length < 20) errors.push(message);
    });
    wc.on("render-process-gone", () => errors.push("The page crashed."));
  }
  try {
    try {
      await Promise.race([wc.loadURL(url.toString()), sleep(30_000).then(() => Promise.reject(new Error("timeout")))]);
    } catch (e) {
      const m = (e as Error).message;
      if (/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/.test(m)) return { error: `Nothing is serving at ${url}. Start its dev server first (in the background), then try again.` };
      // A page still fetching something after 30 seconds is drawn as it stands; one that failed outright isn't.
      if (m !== "timeout" && !/ERR_ABORTED/.test(m)) return { error: `${url} didn't load: ${m}` };
    }
    // Scrollbars hidden, as a Mac shows them; then its fonts, two frames drawn, and a moment for an app that renders after load.
    await wc.insertCSS("::-webkit-scrollbar { display: none !important; }").catch(() => {});
    await Promise.race([wc.executeJavaScript("document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))"), sleep(3000)]).catch(() => {});
    await sleep(300);
    let img: NativeImage;
    let cut = false;
    if (ask.fullPage) {
      // Through the page's debugger, as Chrome's own full-page capture is, so a section sized to the window (100vh) keeps its size.
      const tall = Number(await wc.executeJavaScript("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)").catch(() => height)) || height;
      cut = tall > MAX_PAGE;
      wc.debugger.attach("1.3");
      const r = (await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(height, Math.min(tall, MAX_PAGE)), scale: 1 } })) as { data: string };
      img = nativeImage.createFromBuffer(Buffer.from(r.data, "base64"));
    } else img = await wc.capturePage();
    if (img.isEmpty()) return { error: `${url} drew nothing to capture.` };
    const size = img.getSize();
    const png = img.toPNG();
    const [buf, mimeType] = png.length > MAX_PNG ? [img.toJPEG(80), "image/jpeg"] : [png, "image/png"];
    return { data: buf.toString("base64"), mimeType, width: size.width, height: size.height, ...(cut ? { cut: true } : {}), ...(ask.console ? { errors } : {}) };
  } catch (e) {
    return { error: `The screenshot couldn't be taken: ${(e as Error).message}` };
  } finally {
    win.destroy();
  }
}

// ── Proof clips ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A proof clip (Arun, 2026-11-21: "1. Speed baseline, Today with Tonight, and proof clips."; then "i want this proof clips to be very
 * advanced.... and can be toggled on or off"): a walk through what changed on the page, recorded the way the screenshot is taken, in an
 * offscreen window of this app's own process, with nothing opening on the screen. The walk (src/clip-walk.ts) visits the words the
 * change added, presses what may be pressed among them, and says so; with none on the page, it scrolls the page through.
 *
 * No video library comes with the app, so the clip is made with what Chromium already has. The offscreen window hands over each frame
 * it draws, with when it drew it. Then, in a world of its own on the same page (an isolated world: the page's scripts can't see it, nor
 * it theirs), the frames are played onto a canvas that is never put on the page, with the cursor, ring and captions drawn over them, at
 * the pace they were drawn, while MediaRecorder turns the canvas into WebM. A second window for that would be tidier, but an offscreen
 * window won't load a blank page of its own.
 */
export interface ClipAsk {
  url: string;
  width: number;
  height: number;
  /** The words the change added, to visit (the runner reads them from the diff). */
  targets?: ClipTarget[];
  /** Where to scroll to instead (the "before" clip, walked to where the "after" one stopped). */
  stops?: number[];
  /** A word kept in the corner the whole clip: "Before". */
  badge?: string;
}
export type ClipResult = { data: string; mimeType: string; width: number; height: number; durationMs: number; marks: ClipMark[]; errors: string[]; stops: number[]; gif?: string; /** The same walk as H.264 in a fast-start MP4, base64, when this app can record one. */ mp4?: string } | { error: string };

/** The frames asked for each second and the most a clip may weigh are the runner's too (src/preview-check.ts CLIP). */
const { fps: FPS, maxBytes: MAX_CLIP } = CLIP;
/** The isolated world the walk and the making run in: any number the page's own scripts don't use (they run in world 0). */
const CLIP_WORLD = 1771;

type Frame = { t: number; jpeg: Buffer };

/** A clip of a page on this computer at this size, walked through what changed, or what went wrong. Never throws. */
export async function recordClip(ask: ClipAsk): Promise<ClipResult> {
  let url: URL;
  try {
    url = new URL(String(ask.url));
  } catch {
    return { error: "Give the page's address, e.g. http://localhost:5173/." };
  }
  // Only this computer's pages, whatever asked: the runner checks too.
  if (!/^https?:$/.test(url.protocol) || !LOCAL.test(url.hostname)) return { error: "Only a page served on this machine (localhost) can be recorded." };
  const width = clamp(ask.width, 1280, 320, 1920);
  const height = clamp(ask.height, 800, 240, 1200);
  const targets = (Array.isArray(ask.targets) ? ask.targets : []).filter((t) => t && typeof t.text === "string").slice(0, 3).map((t) => ({ text: t.text.slice(0, 80) }));
  const stops = (Array.isArray(ask.stops) ? ask.stops : []).filter((y) => Number.isFinite(y)).slice(0, 3);
  const badge = typeof ask.badge === "string" ? ask.badge.slice(0, 24) : undefined;
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: shots(), backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.setFrameRate(FPS);
  // A press never takes the page off this app: a link to anywhere else, or a redirect there, is refused.
  const offApp = (e: Electron.Event, to: string) => {
    try {
      if (new URL(to).origin !== url.origin) e.preventDefault();
    } catch {
      e.preventDefault();
    }
  };
  wc.on("will-navigate", offApp);
  wc.on("will-redirect", offApp);
  const errors: string[] = [];
  wc.on("console-message", (...a: unknown[]) => {
    const d = a[0] as { level?: unknown; message?: unknown };
    const level = typeof d?.level === "string" ? d.level : a[1] === 3 ? "error" : "";
    const message = typeof d?.message === "string" ? d.message : typeof a[2] === "string" ? a[2] : "";
    if (level === "error" && message && errors.length < 20) errors.push(message);
  });
  wc.on("render-process-gone", () => errors.push("The page crashed."));
  const frames: Frame[] = [];
  let t0 = 0;
  let recording = false;
  let last: NativeImage | null = null;
  // Only frames drawn while recording are kept; the last one drawn before is the clip's first, so a still page has one too.
  wc.on("paint", (_e, _dirty, image) => {
    if (!recording) return void (last = image);
    if (!image.isEmpty()) frames.push({ t: Date.now() - t0, jpeg: image.toJPEG(80) });
  });
  const run = <T,>(code: string) => wc.executeJavaScriptInIsolatedWorld(CLIP_WORLD, [{ code }]) as Promise<T>;
  try {
    try {
      await Promise.race([wc.loadURL(url.toString()), sleep(30_000).then(() => Promise.reject(new Error("timeout")))]);
    } catch (e) {
      const m = (e as Error).message;
      if (/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/.test(m)) return { error: `Nothing is serving at ${url}. Start its dev server first, then try again.` };
      if (m !== "timeout" && !/ERR_ABORTED/.test(m)) return { error: `${url} didn't load: ${m}` };
    }
    await wc.insertCSS("::-webkit-scrollbar { display: none !important; }").catch(() => {});
    await Promise.race([wc.executeJavaScript("document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))"), sleep(3000)]).catch(() => {});
    await sleep(300);
    t0 = Date.now();
    recording = true;
    const first = last ?? (await wc.capturePage().catch(() => null));
    if (first && !first.isEmpty()) frames.push({ t: 0, jpeg: first.toJPEG(80) });
    // A page that doesn't change draws nothing new: asking for a frame now and then keeps a still page's clip moving in time.
    const tick = setInterval(() => wc.invalidate(), 1000 / FPS);
    let walked;
    try {
      walked = await walkPage({ run, sleep: (ms) => sleep(ms).then(() => {}), now: Date.now }, { t0, width, height, targets, stops });
    } finally {
      clearInterval(tick);
      recording = false;
    }
    if (!frames.length) return { error: `${url} drew nothing to record.` };
    // Made again more lightly when it comes out too heavy to keep beside a chat.
    // The GIF is made once, with the first video: a lighter video doesn't change it.
    let gif: string | undefined;
    for (const bitrate of [2_500_000, 1_200_000, 600_000]) {
      await run("window.__fridayClip = []; 0");
      // In parts, so no one call carries the whole clip.
      for (let i = 0; i < frames.length; i += 20) await run(`window.__fridayClip.push(...${JSON.stringify(frames.slice(i, i + 20).map((f) => [f.t, f.jpeg.toString("base64")]))}); 0`);
      const out = await run<{ data?: string; gif?: string; mp4?: string; error?: string }>(encodeScript({ width, height, durationMs: walked.durationMs, fps: FPS, bitrate, beats: walked.beats, mp4: true, ...(badge ? { badge } : {}), ...(gif === undefined ? { gif: { tries: gifTries(width, height), maxBytes: GIF_MAX_BYTES } } : {}) }));
      if (gif === undefined) gif = out?.gif ?? "";
      if (!out?.data) return { error: out?.error || "The clip couldn't be made." };
      if ((out.data.length * 3) / 4 > MAX_CLIP && bitrate !== 600_000) continue;
      // Its length written in, so a player's bar can seek (MediaRecorder never says it).
      const data = Buffer.from(webmWithDuration(Buffer.from(out.data, "base64"), walked.durationMs)).toString("base64");
      // The MP4 as a player handed a file wants it: one index up front with the duration (MediaRecorder writes it in fragments).
      const mp4 = out.mp4 ? Buffer.from(fastStartMp4(Buffer.from(out.mp4, "base64"))).toString("base64") : undefined;
      return { data, mimeType: "video/webm", width, height, durationMs: walked.durationMs, marks: walked.marks, errors, stops: walked.stops, ...(gif ? { gif } : {}), ...(mp4 ? { mp4 } : {}) };
    }
    return { error: "The clip couldn't be made." };
  } catch (e) {
    return { error: `The clip couldn't be made: ${(e as Error).message}` };
  } finally {
    win.destroy();
  }
}
