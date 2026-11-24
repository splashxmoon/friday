// Preview checks (Arun, 2026-11-19, wave 3: "after a change, Friday opens the app's preview, clicks through what changed and
// shows you screenshots before you look."): which of a run's changed files are the page's own, and which pages they draw.
// Pure, so the runner (which can read the project) and the tests both use it; the page only needs hasUiChange.

/** Files that draw something: a component, a style, a page. A server file or a test changes no picture. */
const UI_FILE = /\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|html?|mdx)$/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__|e2e|tests?)\/|\.(?:test|spec|stories)\.[a-z]+$/i;

export const isUiFile = (path: string): boolean => UI_FILE.test(path) && !TEST_FILE.test(path.replace(/\\/g, "/"));

/** Whether a run's files are worth a look in the preview: any that draw something, and not only by being removed. */
export const hasUiChange = (files: ReadonlyArray<{ path: string; status?: string }>): boolean => files.some((f) => f.status !== "deleted" && isUiFile(f.path));

/** What the project is, as far as guessing routes needs: its dependencies, and whether a path exists in it. */
export interface Layout {
  deps: ReadonlySet<string>;
  has: (path: string) => boolean;
}

/** Most pages looked at in one check: each is two pictures and a load, and a long list is not "before you look". */
export const MAX_PAGES = 4;

const clean = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
const strip = (p: string) => p.replace(/\.[a-z0-9]+$/i, "");
/** A path of folders and names, as a URL's: groups "(x)" vanish, and anything dynamic ("[id]", "@slot", "_x") has no address to open. */
function urlOf(parts: string[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    if (/^\(.*\)$/.test(p)) continue;
    if (/[[\]@]/.test(p) || p.startsWith("_")) return null;
    out.push(p);
  }
  return "/" + out.join("/");
}

const HOME_NAMES = /^(?:index|home|app|main|landing)$/i;
const NEXT_APP_FILE = /^(?:page|layout|template|loading|error|not-found|default)$/;
/** Dependencies that turn files into routes: without one of them, a pages/ or routes/ folder is only a folder. */
const FILE_ROUTERS = new Set(["next", "nuxt", "nuxt3", "astro", "@sveltejs/kit", "vite-plugin-pages", "@remix-run/dev", "@remix-run/react", "@react-router/dev", "@tanstack/react-router", "@tanstack/router-plugin", "vike", "vite-plugin-ssr", "gatsby", "@solidjs/start", "@builder.io/qwik-city", "@analogjs/platform", "unplugin-vue-router"]);
const PAGE_FILE = /\.(?:tsx|jsx|vue|svelte|astro|mdx|js|ts)$/;
const NOT_PAGES = /^(?:components?|partials?|layouts?|lib|utils?|hooks?|styles?|assets)$/i;
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase();

/** The page one changed file belongs to, or null when it is a component or a style that no page of its own owns. */
export function routeOf(file: string, layout: Layout): string | null {
  const p = clean(file);
  const parts = p.split("/");
  const name = strip(parts[parts.length - 1] ?? "");
  const dirs = parts.slice(0, -1);
  const next = layout.deps.has("next");

  // Next's app router: app/ or src/app/, a page or what wraps it (a layout draws every page below it).
  if (next || layout.has("app/layout.tsx") || layout.has("src/app/layout.tsx")) {
    const root = dirs[0] === "app" ? 1 : dirs[0] === "src" && dirs[1] === "app" ? 2 : 0;
    if (root && NEXT_APP_FILE.test(name) && /\.(?:tsx|jsx|js|ts)$/.test(p)) {
      if (name === "not-found" || name === "error" || name === "default") return null;
      return urlOf(dirs.slice(root));
    }
  }
  // Pages that are files: pages/ (Next, Nuxt) and src/pages (Astro, Vue and React routers that follow it); SvelteKit's +page.
  const pagesAt = dirs[0] === "pages" ? 1 : dirs[0] === "src" && dirs[1] === "pages" ? 2 : dirs[0] === "src" && dirs[1] === "routes" ? 2 : dirs[0] === "routes" ? 1 : dirs[0] === "src" && dirs[1] === "views" ? 2 : 0;
  if (pagesAt) {
    // Only where a file router is installed does a file here have an address; a Vite app's src/pages is just components, drawn by
    // whatever routes the app lists, so its files are "any page" (the home page) and never a guess at a path.
    if (![...FILE_ROUTERS].some((d) => layout.deps.has(d))) return null;
    if (!PAGE_FILE.test(p)) return null;
    const rest = dirs.slice(pagesAt);
    if (rest[0] === "api" || name.startsWith("_") || /^\+(?:server|error)/.test(name)) return null;
    // A folder of pieces is no page; nor is a file whose name is more than a name (a module's ".module", a route's "$id" or "index.lazy").
    if (rest.some((d) => NOT_PAGES.test(d))) return null;
    // SvelteKit: a +page is the folder's address, and a +layout draws every page below it.
    if (name === "+page" || name === "+layout") return urlOf(rest);
    if (/[.$:+]/.test(name)) return null;
    // A page named like a home page is "/"; others are their name, lower-cased and dashed (About.tsx -> /about).
    if (HOME_NAMES.test(name) && !rest.length) return "/";
    const own = name.toLowerCase() === "index" ? [] : [kebab(name)];
    return urlOf([...rest, ...own]);
  }
  // Plain sites: an html file at the project's root or in public/ is its own address; any other (a template, a coverage report) is not.
  if (/\.html?$/i.test(p) && (dirs.length === 0 || dirs[0] === "public")) {
    const rest = dirs.slice(1);
    if (name === "index") return "/" + rest.join("/") + (rest.length ? "/" : "");
    return "/" + [...rest, `${name}.html`].join("/");
  }
  return null;
}

/**
 * The pages to look at after a run: the ones the changed files are, and "/" when any file draws on every page or none (a
 * component, a stylesheet, a layout at the root), or when nothing else was found. Conservative: never more than MAX_PAGES, and a
 * guess that isn't a page of this project's is left out rather than opened.
 */
export function pagesFor(files: readonly string[], layout: Layout): string[] {
  const pages: string[] = [];
  let general = false;
  for (const f of files) {
    if (!isUiFile(f)) continue;
    const r = routeOf(f, layout);
    if (r === null) general = true;
    else if (!pages.includes(r)) pages.push(r);
  }
  if (!pages.length || general) {
    // "/" goes after the specific pages, but is never the one dropped.
    if (!pages.includes("/")) pages.push("/");
  }
  if (pages.length <= MAX_PAGES) return pages;
  const keep = pages.filter((p) => p !== "/").slice(0, MAX_PAGES - (pages.includes("/") ? 1 : 0));
  return pages.includes("/") ? [...keep, "/"] : keep;
}

/** The two widths every page is looked at: a laptop's and a phone's. */
export const VIEWS = [
  { label: "Desktop", width: 1280, height: 800 },
  { label: "Phone", width: 390, height: 844 },
] as const;

/** What a console line is worth showing: first line, shortened, without the address of the page it came from. */
export function oneError(line: string): string {
  const first = line.replace(/\x1b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim()) ?? "";
  return first.trim().replace(/\s+/g, " ").slice(0, 240);
}

/** Console errors from several widths of one page: each once, in the order seen, a few. */
export function mergeErrors(lists: ReadonlyArray<readonly string[]>, max = 6): string[] {
  const seen = new Set<string>();
  for (const l of lists) for (const e of l) if (e && seen.size < max) seen.add(oneError(e));
  return [...seen].filter(Boolean);
}

/**
 * A proof clip's walk (Arun, 2026-11-21: "1. Speed baseline, Today with Tonight, and proof clips.", spec 10 C), the same whoever records
 * it (the desktop app's offscreen window, desktop/capture.ts, or Chrome from a runner run from source, runner/preview-check.ts): the
 * page as it loads held a moment, then scrolled to the bottom and held again; a page no taller than its window is held instead. At a
 * laptop's width, the first of VIEWS.
 */
export const CLIP = { holdStart: 1200, scrollMs: 4200, holdEnd: 1200, holdShort: 3500, fps: 15, maxBytes: 6_000_000 } as const;
/** Taller than the window by more than this, a page is scrolled through; less is held, since there is nothing much below to show. */
export const CLIP_SCROLL_OVER = 40;
/** The scroll, eased so it starts and lands gently, run in the page; it resolves when the bottom is reached. */
export const clipScrollScript = (ms: number = CLIP.scrollMs): string =>
  `new Promise((done) => { const to = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) - innerHeight; const t0 = performance.now(); const ease = (x) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; const step = (now) => { const x = Math.min(1, (now - t0) / ${Math.max(0, Math.round(ms))}); window.scrollTo({ top: to * ease(x), behavior: "instant" }); x < 1 ? requestAnimationFrame(step) : done(); }; requestAnimationFrame(step); })`;
/** How long a page's clip runs: the scroll's beats for a tall one, the single hold for a short one. */
export const clipLength = (tall: number, height: number): number => (tall > height + CLIP_SCROLL_OVER ? CLIP.holdStart + CLIP.scrollMs + CLIP.holdEnd : CLIP.holdShort);
/** The clip's file name: "clip-checkout.webm" for /checkout, "clip-home.webm" for /. */
export const clipName = (page: string): string => `clip${page.replace(/[^\w]+/g, "-").replace(/-+$/, "") || "-home"}.webm`;

/**
 * A WebM from MediaRecorder with its length written in. Chromium streams the file and never goes back to say how long it is, so a
 * player's bar can't seek and its clock counts up from nothing; this adds the Duration to the file's Info as a muxer would. Anything
 * not shaped as expected (already has one, an odd layout) comes back as it was: a clip without a length still plays.
 */
export function webmWithDuration(b: Uint8Array, ms: number): Uint8Array {
  // An element's id keeps its length marker; its size doesn't. Both are "variable-length integers": the first byte's leading zeros say how many follow.
  const width = (x: number) => (x === 0 ? 0 : 8 - Math.floor(Math.log2(x)));
  const id = (at: number) => {
    const w = width(b[at] ?? 0);
    if (!w || w > 4) return null;
    let v = 0;
    for (let i = 0; i < w; i++) v = v * 256 + b[at + i]!;
    return { v, w };
  };
  const size = (at: number) => {
    const w = width(b[at] ?? 0);
    if (!w) return null;
    let v = b[at]! & (0xff >> w);
    let unknown = v === 0xff >> w;
    for (let i = 1; i < w; i++) (v = v * 256 + b[at + i]!), (unknown &&= b[at + i] === 0xff);
    return { v, w, unknown };
  };
  const vint = (v: number, w: number) => {
    const out = new Uint8Array(w);
    for (let i = w - 1; i >= 0; i--) (out[i] = v % 256), (v = Math.floor(v / 256));
    out[0]! |= 0x80 >> (w - 1);
    return out;
  };
  const fits = (v: number, w: number) => v < 2 ** (7 * w) - 1;
  const head = id(0);
  const headSize = head && size(head.w);
  if (!head || head.v !== 0x1a45dfa3 || !headSize || headSize.unknown) return b;
  const seg = headSize.w + head.w + headSize.v;
  const segId = id(seg);
  const segSize = segId && size(seg + segId.w);
  if (!segId || segId.v !== 0x18538067 || !segSize) return b;
  // The Segment's children, until its Info.
  let at = seg + segId.w + segSize.w;
  for (let n = 0; n < 16 && at < b.length; n++) {
    const e = id(at);
    const s = e && size(at + e.w);
    if (!e || !s || s.unknown) return b;
    const body = at + e.w + s.w;
    if (e.v !== 0x1549a966) {
      at = body + s.v;
      continue;
    }
    // In the Info: no Duration yet, and the scale its times are counted in (a millionth of a second unless it says otherwise).
    let scale = 1_000_000;
    for (let c = body; c < body + s.v; ) {
      const ce = id(c);
      const cs = ce && size(c + ce.w);
      if (!ce || !cs) return b;
      if (ce.v === 0x4489) return b;
      if (ce.v === 0x2ad7b1) {
        let v = 0;
        for (let i = 0; i < cs.v; i++) v = v * 256 + b[c + ce.w + cs.w + i]!;
        if (v > 0) scale = v;
      }
      c += ce.w + cs.w + cs.v;
    }
    const dur = new Uint8Array(11);
    dur.set([0x44, 0x89, 0x88]);
    new DataView(dur.buffer).setFloat64(3, (ms * 1_000_000) / scale);
    const grown = s.v + dur.length;
    const w = fits(grown, s.w) ? s.w : 8;
    const extra = dur.length + (w - s.w);
    // A Segment of known size grows with it, written back in its own width; Chromium's is "unknown", which needs nothing.
    const segBytes = segSize.unknown ? null : fits(segSize.v + extra, segSize.w) ? vint(segSize.v + extra, segSize.w) : undefined;
    if (segBytes === undefined) return b;
    const out = new Uint8Array(b.length + extra);
    out.set(b.subarray(0, at + e.w), 0);
    if (segBytes) out.set(segBytes, seg + segId.w);
    out.set(vint(grown, w), at + e.w);
    out.set(b.subarray(body, body + s.v), at + e.w + w);
    out.set(dur, at + e.w + w + s.v);
    out.set(b.subarray(body + s.v), at + e.w + w + s.v + dur.length);
    return out;
  }
  return b;
}
