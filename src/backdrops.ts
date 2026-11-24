/**
 * Backdrops: what fills Friday's window behind the app (Arun, 2026-11-20: "app backdrop customization, like claude has it... users
 * can ask their agent or whatever to create a custom UI backdrop for the app"). In Arun's own build first, then
 * the open-source edition in v0.4.1 (Arun, 2026-11-23: "include backdrops and everything involved with it"); app.ts serves these under
 * `o.local`.
 *
 * Each backdrop is a folder under `<FRIDAY_HOME>/backdrops/`: a picture, a video, or a page (index.html, for a canvas or a shader),
 * and optionally backdrop.json naming it. This lists them, serves their files (a page walled off from Friday by its own headers:
 * no network, no Friday, only its own folder), takes a picture or video you add, puts one in the trash, and watches the folder so
 * a saved change shows a moment later. It keeps an AGENTS.md in the folder and a skill in the shared skills library saying how to
 * make one, so any agent asked for a backdrop knows where it goes and what it may do.
 */
import { createReadStream, promises as fs, watch, type FSWatcher } from "node:fs";
import type http from "node:http";
import path from "node:path";

export const BACKDROP_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
export type BackdropKind = "image" | "video" | "page";
export interface Backdrop {
  id: string;
  name: string;
  kind: BackdropKind;
  /** The file that is shown, inside its folder ("index.html", "backdrop.jpg"). */
  file: string;
  /** What it was made for, if it says: a dim scrim of the other tone reads better over it. */
  tone?: "light" | "dark";
  /** How much it asks to be dimmed behind text, 0 to 80, if it says. */
  dim?: number;
  /** Its newest file's time: the page loads it again when this changes. */
  v: number;
}
export interface BackdropsView {
  dir: string;
  version: number;
  backdrops: Backdrop[];
  /** Folders that aren't a backdrop yet, and why: an agent part way through making one. */
  unfinished: { id: string; why: string }[];
}

const IMAGE = /\.(jpe?g|png|webp|avif|gif|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glsl": "text/plain; charset=utf-8",
  ".frag": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
/** A picture or video you add from Settings: the kinds a window can show, and no bigger than this. */
export const ADD_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
export const ADD_MAX = 200 * 1024 * 1024;

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const clampDim = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(80, Math.round(n))) : undefined);
/** A name for a folder, from what someone called it: "Rain on glass!" → "rain-on-glass". */
export const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "backdrop";
const titled = (id: string) => id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** One folder, read: what it shows, or why it can't show yet. */
export async function readBackdrop(root: string, id: string): Promise<Backdrop | { id: string; why: string }> {
  if (!BACKDROP_ID.test(id)) return { id, why: "Its folder's name can only have letters, digits, - and _." };
  const dir = path.join(root, id);
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() || d.isSymbolicLink()).map((d) => d.name);
  } catch {
    return { id, why: "Its folder can't be read." };
  }
  let meta: { name?: unknown; file?: unknown; tone?: unknown; dim?: unknown } = {};
  if (names.includes("backdrop.json")) {
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, "backdrop.json"), "utf8")) as typeof meta;
      if (!meta || typeof meta !== "object") meta = {};
    } catch {
      return { id, why: "Its backdrop.json isn't JSON." };
    }
  }
  const named = typeof meta.file === "string" ? meta.file : "";
  if (named && (named.includes("/") || named.includes("\\") || !names.includes(named))) return { id, why: `Its backdrop.json names ${named}, which isn't in its folder.` };
  const sorted = [...names].sort();
  const file = named || (names.includes("index.html") ? "index.html" : (sorted.find((n) => VIDEO.test(n)) ?? sorted.find((n) => IMAGE.test(n)) ?? ""));
  if (!file) return { id, why: "No index.html, picture or video in it yet." };
  const kind: BackdropKind = /\.html?$/i.test(file) ? "page" : VIDEO.test(file) ? "video" : IMAGE.test(file) ? "image" : ("" as BackdropKind);
  if (!kind) return { id, why: `${file} isn't a page, picture or video.` };
  // Its newest file, one folder down at most: a page's script or shader saved shows too.
  let v = 0;
  const walk = async (d: string, depth: number) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 1) await walk(p, depth + 1);
      } else v = Math.max(v, (await fs.stat(p).catch(() => null))?.mtimeMs ?? 0);
    }
  };
  await walk(dir, 0);
  const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim().slice(0, 60) : titled(id);
  const tone = meta.tone === "light" || meta.tone === "dark" ? meta.tone : undefined;
  const dim = clampDim(meta.dim);
  return { id, name, kind, file, v: Math.round(v), ...(tone ? { tone } : {}), ...(dim !== undefined ? { dim } : {}) };
}

/** How to make one, for an agent: kept as AGENTS.md in the folder and as a skill every coding tool reads. */
export function backdropGuide(dir: string): string {
  return `${GUIDE_MARK}
# Friday backdrops

This folder holds the backdrops Friday can show behind its whole window: ${dir}

Each backdrop is one folder here, named in lowercase with dashes (\`slow-ocean\`). Friday shows a new one as soon as it is saved,
and picks it, and shows a change to it a moment after it is saved.

## What goes in a folder

- \`backdrop.json\`: \`{ "name": "Slow ocean", "tone": "dark" }\`. \`name\` is what Settings shows. \`tone\` is "dark" or "light":
  what the backdrop mostly is: Friday turns light or dark to match it. Optional: \`"file"\`, which file to show.
- And one of:
  - \`index.html\`: a page that draws the backdrop (a canvas, WebGL or CSS). Best for anything that moves.
  - a picture: \`backdrop.jpg\`, \`.png\`, \`.webp\`, \`.avif\` or \`.svg\`.
  - a video: \`backdrop.mp4\` or \`.webm\`. Played muted, on a loop.

## A page (index.html)

- It fills its frame: draw to the full \`innerWidth\` x \`innerHeight\`. Friday makes the frame the size of the whole screen and shows
  the middle of it, so a window being resized never touches it; the person may see only the middle of a small window, so keep what
  matters there or spread across. On \`resize\` (a move to another screen) redraw at once, in the same task as the size change:
  never leave a cleared canvas for a frame. Use \`devicePixelRatio\`, capped at 2.
- It runs walled off: no network at all (no CDNs, no fonts or libraries from the web: put everything inline or in this folder),
  no access to Friday, no storage, no pointer or keyboard input. It may load files from its own folder by relative path with
  \`<script src>\` (a classic script, not \`type="module"\`), \`<link rel="stylesheet">\`, \`<img>\` and \`<video>\`; \`fetch()\`,
  module imports and WebGL textures read from files are refused, so write shaders inline and draw textures in code (or inline
  them as \`data:\` URIs).
- Make it beautiful. A real scene (a landscape, a city at night, weather, the sea), an illustration or a piece of generative art
  is welcome, drawn with care: depth, light, atmosphere, a considered palette. Friday dims and blurs it as the person likes, so
  it needn't be faint. Only: keep the middle of the window, where people read, calmer than the edges; keep motion slow (drifting,
  breathing, a cycle of 20 seconds or more); no text, no logos, nothing that flashes.
- Cheap: one \`requestAnimationFrame\` loop, about 30 frames a second is plenty; never busy-wait.
- Still when asked: if \`location.search\` has \`still=1\`, or \`matchMedia("(prefers-reduced-motion: reduce)")\` matches, draw one
  frame and stop.
- Pause on \`document.hidden\` (\`visibilitychange\`).

## Rules

- Make a new folder for a new backdrop; change an existing one only when asked to.
- Never put anything outside this folder, and never touch AGENTS.md.
- Check it before you are done: the page opens on its own with no errors in the console, and nothing in it reaches the network.
`;
}
export const GUIDE_MARK = "<!-- Friday writes this file. Take this line out to keep your own changes. -->";
const SKILL = (dir: string) => `---
name: friday-backdrop
description: Make or change a backdrop for the Friday app's window (a picture, a video, or an animated canvas/shader page shown behind the whole app). Use when someone asks for a Friday backdrop, background or wallpaper.
---

${backdropGuide(dir)}`;

/** This computer's backdrops: read, watched, added to and put away. */
export class BackdropStore {
  readonly root: string;
  private trash: string;
  private skills: string | null;
  private watcher: FSWatcher | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(version: number) => void>();
  version = 0;

  /** `skills`: the shared skills library (skill-library.ts libraryDir), where the skill that tells agents how goes; none in a test. */
  constructor(o: { root: string; trash: string; skills?: string | null }) {
    this.root = path.resolve(o.root);
    this.trash = path.resolve(o.trash);
    this.skills = o.skills ?? null;
  }

  /** The folder, made if it isn't there, with AGENTS.md and the skill kept current (unless someone made them their own). */
  async ensure(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const keep = async (file: string, text: string, ours: (now: string) => boolean) => {
      const now = await fs.readFile(file, "utf8").catch(() => null);
      if (now === null || (ours(now) && now !== text)) await fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, text));
    };
    await keep(path.join(this.root, "AGENTS.md"), backdropGuide(this.root), (now) => now.startsWith(GUIDE_MARK));
    if (this.skills) await keep(path.join(this.skills, "friday-backdrop", "SKILL.md"), SKILL(this.root), (now) => now.includes(GUIDE_MARK));
  }

  /** Made and watched: a saved change is told 250 ms after the last write of a burst. */
  async start(): Promise<void> {
    await this.ensure().catch((e) => console.error("[backdrops]", (e as Error).message));
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (_, file) => {
        if (file && /^AGENTS\.md$/i.test(String(file))) return;
        if (this.soon) clearTimeout(this.soon);
        this.soon = setTimeout(() => {
          this.soon = null;
          this.bump();
        }, 250);
      });
      this.watcher.on("error", () => this.watcher?.close());
    } catch {
      // A file system that can't be watched: Settings reads the folder again each time it opens.
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.soon) clearTimeout(this.soon);
    this.listeners.clear();
  }

  private bump() {
    this.version++;
    for (const fn of this.listeners) fn(this.version);
  }

  onChange(fn: (version: number) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  async view(): Promise<BackdropsView> {
    const backdrops: Backdrop[] = [];
    const unfinished: { id: string; why: string }[] = [];
    const dirs = (await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"));
    for (const d of dirs) {
      const b = await readBackdrop(this.root, d.name);
      if ("why" in b) unfinished.push(b);
      else backdrops.push(b);
    }
    backdrops.sort((a, b) => b.v - a.v);
    return { dir: this.root, version: this.version, backdrops, unfinished };
  }

  /** A picture or video, added as a backdrop of its own: its folder, named after it. */
  async add(name: string, ext: string, body: Buffer): Promise<Backdrop> {
    await fs.mkdir(this.root, { recursive: true });
    const base = slug(name.replace(/\.[a-z0-9]+$/i, ""));
    let id = base;
    for (let n = 2; await fs.stat(path.join(this.root, id)).then(() => true, () => false); n++) id = `${base}-${n}`;
    const dir = path.join(this.root, id);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, `backdrop.${ext}`), body);
    await fs.writeFile(path.join(dir, "backdrop.json"), JSON.stringify({ name: name.replace(/\.[a-z0-9]+$/i, "").trim().slice(0, 60) || titled(id) }, null, 2) + "\n");
    const b = await readBackdrop(this.root, id);
    this.bump();
    if ("why" in b) throw new Error(b.why);
    return b;
  }

  /** Into Friday's trash, not deleted: a folder taken out by mistake can be put back by hand. */
  async remove(id: string): Promise<void> {
    if (!BACKDROP_ID.test(id)) throw new Error("No such backdrop.");
    const from = path.join(this.root, id);
    await fs.stat(from).catch(() => {
      throw new Error("No such backdrop.");
    });
    await fs.mkdir(this.trash, { recursive: true });
    await fs.rename(from, path.join(this.trash, `${id}-${Date.now()}`));
    this.bump();
  }

  /** A file of one backdrop, only when it really is inside that backdrop's folder once every link is followed. */
  async fileOf(id: string, rel: string): Promise<{ path: string; size: number } | null> {
    if (!BACKDROP_ID.test(id) || !rel || rel.split("/").some((p) => !p || p === "." || p === ".." || p.startsWith(".")) || rel.includes("\\") || rel.includes("\0")) return null;
    try {
      const dir = await fs.realpath(path.join(this.root, id));
      if (!inside(await fs.realpath(this.root), dir)) return null;
      const real = await fs.realpath(path.join(dir, ...rel.split("/")));
      if (!inside(dir, real)) return null;
      const st = await fs.stat(real);
      return st.isFile() ? { path: real, size: st.size } : null;
    } catch {
      return null;
    }
  }
}

/**
 * The headers a backdrop's file is served with: walled off from Friday whatever it is, even opened on its own. A page may run its
 * own scripts and read its own folder, and nothing else: no network, no Friday, no forms, no frames, no storage (sandboxed, so its
 * origin is no one's).
 */
export function backdropHeaders(id: string, file: string, origin: string): Record<string, string> {
  const own = `${origin}/api/local/backdrops/f/${id}/`;
  const ext = path.extname(file).toLowerCase();
  const page = ext === ".html" || ext === ".htm";
  const csp = page
    ? `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ${own}; style-src 'unsafe-inline' ${own}; img-src data: blob: ${own}; media-src data: blob: ${own}; font-src data: ${own}; connect-src 'none'; worker-src blob:; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}`
    : `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: ${own}; frame-ancestors ${origin}`;
  return { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer", "Cache-Control": "no-cache" };
}

/**
 * The routes, from this computer's own page only:
 *   GET    /api/local/backdrops               the list (BackdropsView)
 *   GET    /api/local/backdrops/events        told each time the folder changes (server-sent events)
 *   GET    /api/local/backdrops/f/<id>/<file> one of a backdrop's files, walled off (backdropHeaders), with ranges for a video
 *   POST   /api/local/backdrops?name=<name>   a picture or video in the body (Content-Type its kind): a backdrop of its own
 *   DELETE /api/local/backdrops/<id>          into Friday's trash
 * Answers false for a path it doesn't have.
 */
export async function backdropsHttp(store: BackdropStore, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (p !== "/api/local/backdrops" && !p.startsWith("/api/local/backdrops/")) return false;
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
    return true;
  };
  if (p === "/api/local/backdrops" && req.method === "GET") return send(200, await store.view());
  if (p === "/api/local/backdrops/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive" });
    res.write(`retry: 3000\ndata: ${store.version}\n\n`);
    const off = store.onChange((v) => void res.write(`data: ${v}\n\n`));
    const keep = setInterval(() => void res.write(": still here\n\n"), 45_000);
    keep.unref?.();
    const end = () => (off(), clearInterval(keep));
    req.on("close", end);
    res.on("close", end);
    return true;
  }
  const f = p.match(/^\/api\/local\/backdrops\/f\/([^/]+)\/(.+)$/);
  if (f && (req.method === "GET" || req.method === "HEAD")) {
    let id: string, rel: string;
    try {
      id = decodeURIComponent(f[1]!);
      rel = f[2]!.split("/").map(decodeURIComponent).join("/");
    } catch {
      return send(404, { error: "No such file." });
    }
    const file = await store.fileOf(id, rel);
    if (!file) return send(404, { error: "No such file." });
    const head = backdropHeaders(id, rel, `http://${req.headers.host ?? "127.0.0.1"}`);
    // A range, for a video (seeking, and how a browser loops one).
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : file.size - 1;
      end = Math.min(end, file.size - 1);
      if (start > end || start >= file.size) {
        res.writeHead(416, { "Content-Range": `bytes */${file.size}` });
        return void res.end(), true;
      }
      start = Math.max(0, start);
      res.writeHead(206, { ...head, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${file.size}`, "Content-Length": String(end - start + 1) });
      if (req.method === "HEAD") return void res.end(), true;
      createReadStream(file.path, { start, end }).on("error", () => res.destroy()).pipe(res);
      return true;
    }
    res.writeHead(200, { ...head, "Accept-Ranges": "bytes", "Content-Length": String(file.size) });
    if (req.method === "HEAD") return void res.end(), true;
    createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
    return true;
  }
  if (p === "/api/local/backdrops" && req.method === "POST") {
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = ADD_TYPES[type];
    if (!ext) return send(415, { error: "A backdrop can be a JPEG, PNG, WebP, AVIF or GIF picture, or an MP4, WebM or MOV video." });
    if (Number(req.headers["content-length"] ?? 0) > ADD_MAX) return send(413, { error: "That file is bigger than 200 MB." });
    const parts: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > ADD_MAX) return send(413, { error: "That file is bigger than 200 MB." });
      parts.push(c as Buffer);
    }
    if (!size) return send(400, { error: "That file is empty." });
    try {
      return send(200, { backdrop: await store.add(url.searchParams.get("name") || "Backdrop", ext, Buffer.concat(parts)), ...(await store.view()) });
    } catch (e) {
      return send(500, { error: `Couldn't add it: ${(e as Error).message}` });
    }
  }
  const one = p.match(/^\/api\/local\/backdrops\/([^/]+)$/);
  if (one && req.method === "DELETE") {
    try {
      await store.remove(decodeURIComponent(one[1]!));
      return send(200, await store.view());
    } catch (e) {
      return send(404, { error: (e as Error).message });
    }
  }
  return send(404, { error: "No such route." });
}
