import { GIF_FIXED, GIF_JS } from "./gif.js";
import { CLIP, CLIP_SCROLL_OVER, clipScrollScript, isUiFile } from "./preview-check.js";

/**
 * Proof clips that walk through what changed (Arun, 2026-11-21: "i want this proof clips to be very advanced.... and can be toggled on
 * or off"). A blind scroll shows a page; this shows the change. The words the change added to the page (a heading, a button's label, a
 * placeholder) are read out of its diff, found on the page, and visited one by one: scrolled into view, a cursor glides to each, a soft
 * ring pulses around it with a caption saying what is new, and a button, link or tab among them is pressed so what it opens is seen.
 *
 * The cursor, the ring and the captions are never put on the page: they are drawn onto each frame as the clip is made, so the page's
 * own layout, scripts and styles are untouched, and the clip reads on its own wherever it is watched (GitHub, the phone).
 *
 * Shared by both recorders: the desktop app's offscreen window (desktop/capture.ts) and Chrome from a runner run from source
 * (runner/preview-check.ts). Each hands the walk a way to run a script in the page and a clock; what comes back is the timeline the
 * frames are drawn over.
 */

/** A piece of new text to visit; `click` says the diff wrote it inside something pressable (a hint: the page decides). */
export interface ClipTarget {
  text: string;
  click?: boolean;
}
/** A caption and when it showed, for the card's step list (each one seeks the clip there). */
export interface ClipMark {
  atMs: number;
  label: string;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** What is drawn over the frames, in the clip's own time (ms from its first frame). */
export type ClipBeat =
  | { kind: "move"; at: number; ms: number; x: number; y: number }
  | { kind: "spot"; at: number; until: number; rect: Rect }
  | { kind: "caption"; at: number; until: number; text: string }
  | { kind: "click"; at: number; x: number; y: number };

/** At most this many places are visited: more makes a clip too long to watch at a glance. */
export const MAX_TARGETS = 3;
/** The walk's beats, in ms. */
export const WALK = {
  holdStart: 900,
  scrollSettle: 850,
  glide: 650,
  look: 1250,
  clickSettle: 950,
  afterClick: 1150,
  holdEnd: 800,
  /** No new place is started past this, so the whole clip stays within about 15 seconds. */
  lastStart: 10_500,
  /** A replayed scroll stop (the "before" clip, walked to where the "after" one stopped): the scroll, then the look. */
  stopScroll: 900,
  stopLook: 1700,
} as const;

// ── The words a change added ─────────────────────────────────────────────────────────────────────────────────────────

/** Props whose value people read: a label, a placeholder, a tooltip. Anything else (className, href, id, key, onClick) is code. */
const SEEN_ATTRS = "aria-label|ariaLabel|aria-description|placeholder|title|alt|label|tooltip|heading|subheading|subtitle|caption|description|helperText|emptyText|confirmText|cancelText|buttonText|text";
const ATTR = new RegExp(`(?:^|[\\s{(,<])(?:v-bind:|:)?(?:${SEEN_ATTRS})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`$]*)\`)\\s*\\})`, "g");
/** The same words in an object of options ({ label: "Weekly", value: "w" }), common for menus and tabs. */
const OBJ = /(?:^|[\s{(,])(?:label|title|text|placeholder|heading|description|caption|tooltip)\s*:\s*(["'`])([^"'`$\n]{2,80})\1/g;
const KEYWORD = /^(?:return|const|let|var|if|else|case|default|break|continue|await|async|function|type|interface|import|export|from|new|throw|try|catch|finally|class|extends|yield|typeof|instanceof|delete|void|switch|for|while|do|enum|declare|namespace|module|require|use)\b/;
const CLICKY = /<(?:button|a|Link|NavLink|summary|Button|IconButton|Tab|MenuItem|DropdownMenuItem)\b|\brole\s*=\s*["'](?:tab|button|link)["']/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", mdash: "—", ndash: "–", middot: "·", times: "×", copy: "©" };

const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)));

/** Whether a piece of text is words a person reads, not code that happens to sit where text could. */
export function readableText(raw: string): string | null {
  let t = decode(raw).replace(/\s+/g, " ").trim();
  t = t.replace(/^[,;:|·•–—-]+\s*/, "").replace(/\s*[,;:|·•–—-]+$/, "").trim();
  // A quoted string as a whole (a Vue binding's ':label="\'Save\'"'): its inside.
  const q = t.match(/^(["'`])(.*)\1$/);
  if (q) t = q[2]!.trim();
  if (t.length < 2 || t.length > 80) return null;
  if (!/\p{L}/u.test(t)) return null;
  if (/[{}<>=;`\\]|=>|&&|\|\||\(\)|^\/\/|^\/\*|^\*\s|\$\{/.test(t)) return null;
  if (KEYWORD.test(t)) return null;
  // A ternary or a type: "open ? a : b", "name?: string".
  if (/\s\?\s.*\s:\s|\w\?:/.test(t)) return null;
  // An address or a path, a dotted name, a file.
  if (/^(?:https?:|mailto:|\/|\.\.?\/|#|@)/.test(t) || (/[/\\]/.test(t) && !/\s/.test(t)) || /^[\w$]+(?:\.[\w$]+)+$/.test(t)) return null;
  // One token: a word as people write it ("Save", "OK", "Settings"), never an identifier ("isOpen", "handle_click", "loading").
  if (!/\s/.test(t) && !/^(?:\p{Lu}[\p{Ll}'’]+|\p{Lu}{2,5})[!?.…]?$/u.test(t)) return null;
  // A list of class names: every word lowercase with dashes or colons ("flex items-center gap-2", "md:px-4").
  const words = t.split(" ");
  if (words.every((w) => /^[a-z0-9:[\]/.%#!-]+$/.test(w)) && words.some((w) => /[-:[\]]/.test(w))) return null;
  // Code with spaces: a call, a member, an operator between names.
  if (/^[\w$.]+\(|\)\s*$|[\w$]\s*[+*/%]\s*[\w$]/.test(t) && !/[.!?…]$/.test(t)) return null;
  return t;
}

/** The readable pieces of one line of markup (JSX, HTML, Vue or Svelte templates). */
function piecesOf(line: string, markupFile: boolean): string[] {
  const out: string[] = [];
  const trimmed = line.trim();
  if (!trimmed || /^(?:\/\/|\/\*|\*|<!--|#|import\s|export\s+(?:\*|\{|type\s|default\s+from)|@import|@use)/.test(trimmed)) return out;
  // Props and options people read, whatever surrounds them.
  for (const m of line.matchAll(ATTR)) {
    const v = m.slice(1).find((x) => x !== undefined);
    if (v !== undefined) out.push(v);
  }
  for (const m of line.matchAll(OBJ)) out.push(m[2]!);
  // Text between tags. Expressions go ({count}, {{ name }}, {#if x}); a string written as a child ({"Save"}) stays.
  let s = line.replace(/=>/g, "  ").replace(/\{\s*(["'`])([^"'`{}$]*)\1\s*\}/g, " $2 ");
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/\{[^{}]*\}/g, "\u0000");
    if (next === s) break;
    s = next;
  }
  const hasTag = /<\/?[A-Za-z][^<>]*\/?>/.test(s);
  s = s.replace(/<\/?[A-Za-z][^<>]*\/?>/g, "\u0000");
  for (let piece of s.split("\u0000")) {
    // A tag left open on this line ("<p className=…") or closed from the last ("…'>Welcome"): only what is outside it.
    if (piece.includes("<")) piece = piece.slice(0, piece.indexOf("<"));
    if (piece.includes(">")) piece = piece.slice(piece.lastIndexOf(">") + 1);
    if (!piece.trim()) continue;
    // A line with no tag at all is text only inside markup, and only when it reads as words, not as a statement.
    if (!hasTag && (!markupFile || /[=;(){}[\]]|,\s*$|^\s*["'`]/.test(piece) || KEYWORD.test(piece.trim()))) continue;
    out.push(piece);
  }
  return out;
}

/**
 * The words a change added to the page, read from its unified diff: up to `max`, in the order they appear, each once, and none that
 * the same file already had (a line changed only in its classes keeps its words, and they aren't new). Only files that draw something.
 */
export function clipTargets(diff: string, max = MAX_TARGETS): ClipTarget[] {
  const added = new Map<string, ClipTarget & { file: string }>();
  const removed = new Set<string>();
  let file = "";
  let ui = false;
  let markup = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "").trim();
      ui = file !== "/dev/null" && isUiFile(file) && !/\.(?:css|scss|sass|less)$/i.test(file);
      markup = /\.(?:tsx|jsx|vue|svelte|astro|html?|mdx)$/i.test(file);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("@@") || !ui) continue;
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    const body = line.slice(1);
    for (const p of piecesOf(body, markup)) {
      const t = readableText(p);
      if (!t) continue;
      const key = `${file}\u0000${t.toLowerCase()}`;
      if (sign === "-") removed.add(key);
      else if (!added.has(key)) added.set(key, { text: t, file, ...(CLICKY.test(body) ? { click: true } : {}) });
    }
  }
  const out: ClipTarget[] = [];
  for (const [key, t] of added) {
    if (removed.has(key)) continue;
    const low = t.text.toLowerCase();
    // One place once: "Save" and "Save changes" are the same button.
    if (out.some((o) => o.text.toLowerCase().includes(low) || low.includes(o.text.toLowerCase()))) continue;
    out.push({ text: t.text, ...(t.click ? { click: true } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

// ── In the page ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the walk keeps in the page between its steps: how text is compared, what counts as seen, and what may be pressed. Pressable
 * means a link to this same app (not another site, not a new window, not a download), a button that doesn't submit a form, a summary,
 * or something marked as a tab or button; never one that is disabled, and never one whose words say it would delete, pay, send,
 * sign out or publish something. Kept in the world the recorder runs scripts in (the desktop app's own isolated world).
 */
export const KIT_SCRIPT = `(() => {
  if (window.__fridayClipKit) return true;
  const norm = (s) => String(s || "").replace(/[\\u2018\\u2019]/g, "'").replace(/[\\u201C\\u201D]/g, '"').replace(/\\s+/g, " ").trim().toLowerCase();
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05; };
  const RISKY = /\\b(delete|remove|destroy|discard|sign ?out|log ?out|pay|buy|purchase|checkout|subscribe|unsubscribe|reset|erase|send|publish|deploy|merge|archive|cancel (?:my )?(?:plan|subscription)|close account)\\b/i;
  const PRESS = "a[href],button,summary,[role=tab],[role=button],[role=link]";
  const pressable = (el) => {
    const c = el && el.closest ? el.closest(PRESS) : null;
    if (!c || c.closest("[disabled],[aria-disabled=true],fieldset[disabled]")) return null;
    if (c.tagName === "A") {
      try { const u = new URL(c.getAttribute("href"), location.href); if (u.origin !== location.origin || c.target === "_blank" || c.hasAttribute("download")) return null; } catch (e) { return null; }
    }
    if (c.tagName === "BUTTON") { const t = (c.getAttribute("type") || "").toLowerCase(); if (t === "submit" || t === "reset" || (!t && c.form)) return null; }
    if (RISKY.test(c.textContent || "") || RISKY.test(c.getAttribute("aria-label") || "")) return null;
    return c;
  };
  // Never a form sent, never a link off this app followed, whatever is pressed.
  document.addEventListener("submit", (e) => e.preventDefault(), true);
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    try { const u = new URL(a.getAttribute("href"), location.href); if (u.origin !== location.origin || a.target === "_blank") e.preventDefault(); } catch (x) { e.preventDefault(); }
  }, true);
  window.__fridayClipKit = { norm, visible, pressable, targets: [] };
  return true;
})()`;

/**
 * Finds each text on the page: an element whose label (aria-label, placeholder, title, alt) says it exactly, else the smallest seen
 * element holding it. Read from the page's text nodes, so a large page costs one pass, not one per element: a text node that holds the
 * words is the place; words split across tags ("Save <b>changes</b>") are found by climbing a few levels from where the first word is.
 */
export const findScript = (texts: string[]): string => `(() => {
  const k = window.__fridayClipKit; if (!k || !document.body) return [];
  const nodes = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n && nodes.length < 20000; n = w.nextNode()) {
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
    const t = k.norm(n.nodeValue);
    if (t) nodes.push([t, p]);
  }
  const labelled = Array.from(document.body.querySelectorAll("[aria-label],[placeholder],[title],[alt]"));
  return ${JSON.stringify(texts)}.map((text, i) => {
    const want = k.norm(text);
    let best = labelled.find((el) => ["aria-label", "placeholder", "title", "alt"].some((a) => k.norm(el.getAttribute(a)) === want) && k.visible(el)) || null;
    if (!best) for (const [t, p] of nodes) if (t.includes(want) && k.visible(p)) { best = p; break; }
    if (!best) {
      const first = want.split(" ")[0];
      for (const [t, p] of nodes) {
        if (!t.includes(first)) continue;
        let el = p;
        for (let up = 0; up < 4 && el && el !== document.body; up++, el = el.parentElement) if (k.norm(el.textContent).includes(want)) { if (k.visible(el)) best = el; break; }
        if (best) break;
      }
    }
    k.targets[i] = best;
    return { found: !!best, press: !!(best && k.pressable(best)) };
  });
})()`;

/** Scrolls the i-th target to the middle of the window, smoothly. */
export const toTargetScript = (i: number): string => `(() => { const el = window.__fridayClipKit && window.__fridayClipKit.targets[${i}]; if (!el || !el.isConnected) return false; el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); return true; })()`;

/** Where the i-th target is now, in the window (what is pressable about it, when something is), and how far the page is scrolled. */
export const rectScript = (i: number): string => `(() => {
  const k = window.__fridayClipKit; const el = k && k.targets[${i}]; if (!el || !el.isConnected) return null;
  const box = (k.pressable(el) || el).getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  return { x: box.left, y: box.top, w: box.width, h: box.height, sy: Math.round(scrollY) };
})()`;

/** Presses the i-th target when it may be pressed; says whether it was. */
export const pressScript = (i: number): string => `(() => { const k = window.__fridayClipKit; const el = k && k.targets[${i}]; const c = el && el.isConnected && k.pressable(el); if (!c) return false; c.click(); return true; })()`;

const tallScript = "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)";
const scrollToScript = (y: number) => `new Promise((done) => { window.scrollTo({ top: ${Math.max(0, Math.round(y))}, behavior: "smooth" }); setTimeout(done, ${WALK.stopScroll}); })`;

// ── The walk ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a recorder lets the walk act: a script run in the page (its answer back), a wait, and the clock its frames are timed by. */
export interface ClipDriver {
  run<T = unknown>(js: string): Promise<T>;
  sleep(ms: number): Promise<void>;
  now(): number;
}
export interface Walked {
  beats: ClipBeat[];
  marks: ClipMark[];
  /** How far the page was scrolled at each place visited: the "before" clip is walked to the same places. */
  stops: number[];
  durationMs: number;
}

/** Where the cursor waits before its first move: low and a little right of the middle, where a hand on a trackpad rests. */
export const cursorHome = (width: number, height: number) => ({ x: Math.round(width * 0.62), y: Math.round(height * 0.8) });

/**
 * The walk itself, from `t0` (the moment the recorder's frames count from). With targets that are on the page: each visited and the
 * pressable ones pressed. With scroll stops (the "before" clip): scrolled to each and held. With neither: the page scrolled top to
 * bottom, as before targets existed. Never throws: a step the page refuses is skipped.
 */
export async function walkPage(d: ClipDriver, o: { t0: number; width: number; height: number; targets?: ClipTarget[]; stops?: number[] }): Promise<Walked> {
  const at = () => d.now() - o.t0;
  const run = <T,>(js: string) => d.run<T>(js).catch(() => null as T | null);
  const beats: ClipBeat[] = [];
  const marks: ClipMark[] = [];
  const stops: number[] = [];
  await run(KIT_SCRIPT);
  const targets = (o.targets ?? []).slice(0, MAX_TARGETS);
  const found = targets.length ? ((await run<{ found: boolean; press: boolean }[]>(findScript(targets.map((t) => t.text)))) ?? []) : [];
  const visit = targets.map((t, i) => ({ t, i, ...(found[i] ?? { found: false, press: false }) })).filter((v) => v.found);
  await d.sleep(WALK.holdStart);
  if (visit.length) {
    let cursor = cursorHome(o.width, o.height);
    for (const v of visit) {
      if (at() > WALK.lastStart) break;
      if (!(await run<boolean>(toTargetScript(v.i)))) continue;
      await d.sleep(WALK.scrollSettle);
      const r = await run<Rect & { sy: number }>(rectScript(v.i));
      if (!r) continue;
      stops.push(r.sy);
      const to = { x: Math.round(r.x + Math.min(r.w / 2, 60)), y: Math.round(r.y + r.h / 2) };
      beats.push({ kind: "move", at: at(), ms: WALK.glide, ...to });
      cursor = to;
      await d.sleep(WALK.glide);
      const seen = at();
      const rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
      const label = `New: “${v.t.text}”`;
      marks.push({ atMs: seen, label });
      await d.sleep(WALK.look);
      let pressed = false;
      if (v.press && at() < WALK.lastStart + 2000) {
        beats.push({ kind: "click", at: at(), ...cursor });
        pressed = !!(await run<boolean>(pressScript(v.i)));
      }
      beats.push({ kind: "spot", at: seen, until: at(), rect }, { kind: "caption", at: seen, until: at(), text: label });
      if (pressed) {
        await d.sleep(WALK.clickSettle);
        const said = `Clicked “${v.t.text}”`;
        const from = at();
        marks.push({ atMs: from, label: said });
        await d.sleep(WALK.afterClick);
        beats.push({ kind: "caption", at: from, until: at(), text: said });
      }
    }
  } else if (o.stops?.length) {
    for (const y of o.stops.slice(0, MAX_TARGETS)) {
      await run(scrollToScript(y));
      await d.sleep(WALK.stopLook);
    }
  }
  // Nothing to visit (no new words, none on this page): the page scrolled through, as a plain clip is.
  if (!marks.length && !o.stops?.length) {
    const tall = Number(await run<number>(tallScript)) || o.height;
    if (tall > o.height + CLIP_SCROLL_OVER) {
      await d.sleep(CLIP.holdStart - WALK.holdStart);
      await run(clipScrollScript());
    } else await d.sleep(CLIP.holdShort - WALK.holdStart - WALK.holdEnd);
  }
  await d.sleep(WALK.holdEnd);
  return { beats, marks, stops, durationMs: at() };
}

// ── Making the clip ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface EncodeAsk {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  bitrate: number;
  beats: ClipBeat[];
  /** A word kept in the corner the whole clip ("Before"), when the clip is one of a pair. */
  badge?: string;
  /** Also an MP4 (H.264) of the same walk, for an iPhone, whose older WebKit doesn't play VP9: recorded alongside when the browser can. */
  mp4?: boolean;
  /** Also a GIF of the same walk, for pull requests and anywhere a video won't play: tried at each size and pace in turn until one fits. */
  gif?: { tries: { width: number; height: number; fps: number }[]; maxBytes: number };
}

/** The GIF's sizes and paces to try, largest first: about 800 wide at 8 a second, then smaller and slower until it fits in the limit. */
export function gifTries(width: number, height: number): { width: number; height: number; fps: number }[] {
  const at = (w: number, fps: number) => ({ width: Math.min(width, w), height: Math.round((height * Math.min(width, w)) / width), fps });
  return [at(800, 8), at(640, 6), at(480, 5)];
}
export const GIF_MAX_BYTES = 4_000_000;

/**
 * The script that makes the WebM, run in a page that holds the frames as `window.__fridayClip` ([ms, base64 JPEG] pairs): each frame
 * drawn onto a canvas that is never shown, at the pace it was recorded, with the cursor, ring, captions and badge drawn over it, while
 * MediaRecorder records the canvas. Resolves to { data: base64 } or { error }.
 */
export function encodeScript(a: EncodeAsk): string {
  return `(async () => {
  const A = ${JSON.stringify(a)};
  const W = A.width, H = A.height, D = A.durationMs;
  const bytes = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const list = (await Promise.all((window.__fridayClip || []).map(([t, b]) => createImageBitmap(new Blob([bytes(b)], { type: "image/jpeg" })).then((i) => ({ t, i }), () => null)))).filter(Boolean);
  window.__fridayClip = null;
  if (!list.length) return { error: "No frame could be read." };
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!type) return { error: "This browser can't make a video." };
  const S = W >= 900 ? 1 : 0.86;
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const fade = (t, a, b, ms) => Math.max(0, Math.min(1, (t - a) / ms, (b - t) / ms));
  const moves = A.beats.filter((b) => b.kind === "move").sort((x, y) => x.at - y.at);
  const home = { x: Math.round(W * 0.62), y: Math.round(H * 0.8) };
  const cursorAt = (t) => {
    if (!moves.length || t < moves[0].at) return null;
    let from = home, p = home;
    for (const m of moves) {
      if (t < m.at) break;
      const k = Math.min(1, (t - m.at) / m.ms), e = ease(k);
      p = { x: from.x + (m.x - from.x) * e, y: from.y + (m.y - from.y) * e };
      from = { x: m.x, y: m.y };
    }
    return p;
  };
  const round = (x, y, w, h, r, keep) => { if (!keep) g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const chip = (text, x, y, align, alpha, dot) => {
    g.save(); g.globalAlpha = alpha;
    g.font = "600 " + Math.round(15 * S) + "px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
    let s = text; while (g.measureText(s).width > W - 64 * S && s.length > 4) s = s.slice(0, -2);
    if (s !== text) s = s.replace(/.$/, "…");
    const tw = g.measureText(s).width, pad = 13 * S, h = 32 * S, dw = dot ? 14 * S : 0, w = tw + pad * 2 + dw;
    const left = align === "center" ? x - w / 2 : x;
    g.shadowColor = "rgba(0,0,0,0.28)"; g.shadowBlur = 14 * S; g.shadowOffsetY = 3 * S;
    round(left, y, w, h, h / 2); g.fillStyle = "rgba(20,20,22,0.88)"; g.fill();
    g.shadowColor = "transparent";
    if (dot) { g.beginPath(); g.arc(left + pad + 4 * S, y + h / 2, 4 * S, 0, Math.PI * 2); g.fillStyle = dot; g.fill(); }
    g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText(s, left + pad + dw, y + h / 2 + 0.5);
    g.restore();
  };
  const overlay = (t) => {
    for (const b of A.beats) {
      if (b.kind !== "spot" || t < b.at || t > b.until) continue;
      const a = fade(t, b.at, b.until, 220), p = 7 * S;
      const x = b.rect.x - p, y = b.rect.y - p, w = b.rect.w + p * 2, h = b.rect.h + p * 2;
      // A soft dim around it, then the ring, breathing.
      g.save(); g.globalAlpha = a * 0.26; g.fillStyle = "#0b0b0d"; g.beginPath(); g.rect(0, 0, W, H); round(x, y, w, h, 10 * S, true); g.fill("evenodd"); g.restore();
      const pulse = 0.5 + 0.5 * Math.sin(((t - b.at) / 900) * Math.PI * 2);
      g.save(); g.globalAlpha = a; g.strokeStyle = "rgba(64,132,255," + (0.55 + 0.45 * pulse) + ")"; g.lineWidth = (2.2 + pulse * 1.2) * S;
      g.shadowColor = "rgba(64,132,255,0.55)"; g.shadowBlur = (10 + pulse * 10) * S; round(x, y, w, h, 10 * S); g.stroke(); g.restore();
    }
    for (const b of A.beats) {
      if (b.kind !== "click" || t < b.at || t > b.at + 480) continue;
      const k = (t - b.at) / 480;
      g.save(); g.globalAlpha = (1 - k) * 0.55; g.fillStyle = "rgba(64,132,255,1)"; g.beginPath(); g.arc(b.x, b.y, (8 + 26 * k) * S, 0, Math.PI * 2); g.fill(); g.restore();
    }
    const p = cursorAt(t);
    if (p) {
      const down = A.beats.some((b) => b.kind === "click" && t >= b.at && t < b.at + 160);
      const s = (down ? 1.18 : 1.3) * S;
      g.save(); g.translate(p.x, p.y); g.scale(s, s);
      g.shadowColor = "rgba(0,0,0,0.35)"; g.shadowBlur = 5; g.shadowOffsetY = 1.5;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 17); g.lineTo(4.4, 13.1); g.lineTo(7.4, 20); g.lineTo(10.2, 18.8); g.lineTo(7.3, 12.2); g.lineTo(12.6, 12.2); g.closePath();
      g.fillStyle = "#fff"; g.fill(); g.shadowColor = "transparent"; g.lineWidth = 1.25; g.strokeStyle = "#111"; g.lineJoin = "round"; g.stroke();
      g.restore();
    }
    for (const b of A.beats) {
      if (b.kind !== "caption" || t < b.at || t > b.until) continue;
      const spot = A.beats.find((s) => s.kind === "spot" && t >= s.at && t <= s.until);
      const low = spot && spot.rect.y + spot.rect.h > H * 0.72;
      chip(b.text, W / 2, low ? 18 * S : H - 52 * S, "center", fade(t, b.at, b.until, 180));
    }
    // Top right, where a page's own heading and logo seldom are.
    if (A.badge) { g.save(); g.font = "600 " + Math.round(15 * S) + "px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"; const bw = g.measureText(A.badge).width + 26 * S + 14 * S; g.restore(); chip(A.badge, W - 16 * S - bw, 16 * S, "left", 1, "#f5a524"); }
  };
  const draw = (img, t) => { g.drawImage(img, 0, 0, W, H); overlay(t); };
  draw(list[0].i, 0);
  const stream = c.captureStream(A.fps);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: A.bitrate });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((ok) => (rec.onstop = ok));
  // The MP4 is a second recorder on the same canvas, so both see the very same frames (H.264, which an iPhone's player takes).
  const mp4Type = A.mp4 ? ["video/mp4;codecs=avc1", "video/mp4;codecs=avc1.42E01E", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) : null;
  const mp4Rec = mp4Type ? new MediaRecorder(stream, { mimeType: mp4Type, videoBitsPerSecond: A.bitrate }) : null;
  const mp4Parts = [];
  let mp4Stopped = Promise.resolve();
  if (mp4Rec) { mp4Rec.ondataavailable = (e) => e.data.size && mp4Parts.push(e.data); mp4Stopped = new Promise((ok) => (mp4Rec.onstop = ok)); mp4Rec.start(500); }
  rec.start(500);
  const t0 = performance.now();
  let n = 0;
  await new Promise((ok) => {
    const id = setInterval(() => {
      const t = performance.now() - t0;
      while (n + 1 < list.length && list[n + 1].t <= t) n++;
      draw(list[n].i, Math.min(t, D));
      if (t >= D) { clearInterval(id); ok(); }
    }, Math.round(1000 / (A.fps * 2)));
  });
  rec.stop();
  if (mp4Rec) mp4Rec.stop();
  await stopped;
  await mp4Stopped;
  const b64 = (buf) => { let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); };
  const webm = b64(new Uint8Array(await new Blob(parts, { type: "video/webm" }).arrayBuffer()));
  const mp4 = mp4Parts.length ? b64(new Uint8Array(await new Blob(mp4Parts, { type: "video/mp4" }).arrayBuffer())) : null;
  // The same walk as a GIF: each moment drawn as the video drew it (frame, cursor, ring, caption), shrunk, and added to the encoder.
  let gif = null, gifError = null;
  if (A.gif) {
    ${GIF_JS}
    for (const tr of A.gif.tries) {
      const gc = document.createElement("canvas"); gc.width = tr.width; gc.height = tr.height;
      const gg = gc.getContext("2d", { willReadFrequently: true });
      gg.imageSmoothingQuality = "high";
      const shot = (t) => { let k = 0; while (k + 1 < list.length && list[k + 1].t <= t) k++; draw(list[k].i, t); gg.drawImage(c, 0, 0, tr.width, tr.height); return gg.getImageData(0, 0, tr.width, tr.height).data; };
      const step = 1000 / tr.fps;
      const mk = fridayGif(tr.width, tr.height, [0.05, 0.35, 0.65, 0.95].map((f) => shot(D * f)), ${JSON.stringify(GIF_FIXED)});
      let fits = true;
      for (let t = 0; t < D; t += step) { mk.add(shot(t), step / 10); if (mk.size() > A.gif.maxBytes) { fits = false; break; } }
      if (fits) { gif = b64(mk.finish()); break; }
      gifError = "The GIF came out too big to keep.";
    }
  }
  for (const f of list) f.i.close();
  return { data: webm, ...(mp4 ? { mp4 } : {}), ...(gif ? { gif } : gifError ? { gifError } : {}) };
})()`;
}

// ── Before the change ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which commit is "before": the change still uncommitted is compared with what was last committed (HEAD); a committed change on a
 * branch with where the branch left the default one (the merge-base); committed on the default branch itself (the merge-base is HEAD),
 * the commit before. Null when there is nothing before it (the first commit).
 */
export function beforeBase(f: { dirty: boolean; head: string; mergeBase: string | null; parent: string | null }): string | null {
  if (f.dirty) return f.head;
  if (f.mergeBase && f.mergeBase !== f.head) return f.mergeBase;
  return f.parent;
}
