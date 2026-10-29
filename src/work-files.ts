/**
 * What a Work session has made (engine/work.ts), for its Documents, Media and Sources panels (client/WorkPanels.tsx): the files
 * in the folders its agents work in, listed newest first, and each one served as itself, so a picture shows, a video plays and
 * seeks, and a Markdown piece is rendered rather than read as code.
 *
 * The open-source edition only, where the server and the folders are on the same computer (app.ts, o.local).
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { headingOf, wordCount } from "./client/work-outputs.js";

export type WorkKind = "doc" | "image" | "video" | "audio";

export interface WorkFile {
  /** Which of the session's folders it is in (`roots`), and where in it. */
  root: number;
  path: string;
  kind: WorkKind;
  size: number;
  mtime: number;
  /** A piece of writing's own title (its first heading), the first lines of its text, and how long it is. */
  title?: string;
  excerpt?: string;
  words?: number;
  /** A table's columns and how many rows it has. */
  columns?: string[];
  rows?: number;
  /** The first of a run of numbered frames (frame0001.png … frame0720.png), standing for all of them: how many. */
  frames?: number;
}

/** What a written piece says about itself, read once per version of it (the panels ask every few seconds). */
const summaries = new Map<string, Pick<WorkFile, "title" | "excerpt" | "words" | "columns" | "rows">>();
const SUMMARY_MAX = 512 * 1024;

/** Markdown's marks off a line: `**Status:** draft` reads "Status: draft". */
const plain = (l: string) =>
  l
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/^\s*(?:[-+*]|\d+[.)]|>)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The first lines of a piece as a person should meet them: its `description:` when it has one, else its first paragraph of plain
 * words, never an agent's working notes ("Status: foundation draft. The user has now authorized…"), which a collection's card
 * showed first (the 2026-10-28 critique; Arun, 2026-10-28: "iron everything… focusing on UI and UX"). A leading label
 * ("Purpose:", "Summary:") is left off.
 */
const NOTES = /^(status|note|notes|nb|todo|fixme|wip|update|updated|draft|caveat|internal|agent note|working note)s?\b\s*[:\-–—]|^(the user|user has|per the user|as the user|i have|i've|we have|we've)\b/i;
const LABEL = /^(purpose|summary|about|overview|description|goal|tl;?dr)\s*[:\-–—]\s*/i;
export function blurbOf(lines: string[], heading?: string, front?: string): string {
  const said = front && /^description\s*:\s*(.+)$/im.exec(front)?.[1]?.replace(/^["']|["']$/g, "").trim();
  if (said) return plain(said).slice(0, 240);
  let excerpt = "";
  let fenced = false;
  let skipping = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fenced = !fenced;
    if (fenced || /^\s*(#|```|\||<|---|===)/.test(l) || l === heading) continue;
    const t = plain(l);
    if (!t) {
      if (excerpt) break;
      skipping = false;
      continue;
    }
    // A paragraph that opens as a working note is passed over whole, to the next.
    if (!excerpt && (skipping || NOTES.test(t))) {
      skipping = true;
      continue;
    }
    const words = excerpt ? t : t.replace(LABEL, "").replace(/^./, (c) => c.toUpperCase());
    excerpt = excerpt ? `${excerpt} ${words}` : words;
    if (excerpt.length > 220) break;
  }
  return excerpt.slice(0, 240);
}

function summarise(text: string, ext: string): Pick<WorkFile, "title" | "excerpt" | "words" | "columns" | "rows"> {
  // A page an agent made: its <title> (else its first heading), its description (else its first words), as text.
  if (ext === ".html") {
    // A tag is a space, but none before the punctuation after it: "<a>a link out</a>, <a>an anchor</a>" read "a link out , an
    // anchor ," in the card (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY VISUAL").
    const bare = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").replace(/ ([,.;:!?)\]])/g, "$1").replace(/([(\[]) /g, "$1").trim();
    const title = bare(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1] ?? "");
    const body = bare((/<body[^>]*>([\s\S]*)<\/body>/i.exec(text)?.[1] ?? text).replace(/<(script|style|svg|head)[\s\S]*?<\/\1>/gi, " "));
    const described = /<meta\s+name=["']description["']\s+content=["']([^"']+)/i.exec(text)?.[1];
    const excerpt = (described ?? body.replace(title, "").trim()).slice(0, 240);
    return { ...(title ? { title: title.slice(0, 140) } : {}), ...(excerpt ? { excerpt } : {}), words: body.split(/\s+/).filter((w) => /\w/.test(w)).length };
  }
  if (ext === ".csv") {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return { columns: (lines[0] ?? "").split(",").map((c) => c.replace(/^"|"$/g, "").trim()).filter(Boolean).slice(0, 8), rows: Math.max(0, lines.length - 1) };
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const body = front ? text.slice(front[0].length) : text;
  const lines = body.split(/\r?\n/);
  const heading = lines.find((l) => /^#{1,2}\s+\S/.test(l));
  // The same heading the reader and the chat's chips take (client/work-outputs.ts headingOf).
  const said = headingOf(text);
  const title = said ? plain(said) : undefined;
  const excerpt = blurbOf(lines, heading, front?.[1]);
  // Counted as the reader counts it (client/work-outputs.ts), so the card and the reader say the same number.
  const words = wordCount(text);
  return { ...(title ? { title: title.slice(0, 140) } : {}), ...(excerpt ? { excerpt: excerpt.slice(0, 240) } : {}), words };
}

async function summary(file: string, size: number, mtime: number): Promise<Pick<WorkFile, "title" | "excerpt" | "words" | "columns" | "rows">> {
  const ext = path.extname(file).toLowerCase();
  if (![".md", ".markdown", ".txt", ".csv", ".html"].includes(ext) || size > SUMMARY_MAX) return {};
  const key = `${file}|${mtime}`;
  const had = summaries.get(key);
  if (had) return had;
  try {
    const s = summarise(await readFile(file, "utf8"), ext);
    if (summaries.size > 2000) summaries.clear();
    summaries.set(key, s);
    return s;
  } catch {
    return {};
  }
}

const KINDS: Record<string, WorkKind> = {
  ".md": "doc", ".markdown": "doc", ".txt": "doc", ".html": "doc", ".csv": "doc", ".pdf": "doc", ".docx": "doc", ".pptx": "doc", ".xlsx": "doc", ".rtf": "doc",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image", ".avif": "image",
  ".mp4": "video", ".mov": "video", ".webm": "video", ".m4v": "video",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio",
};

const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".html": "text/plain; charset=utf-8", ".rtf": "text/plain; charset=utf-8", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/mp4",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
};

/** Folders nobody writes a piece into: tools' own, and dependencies. */
const SKIP = new Set(["node_modules", "dist", "build", "venv", "__pycache__"]);
const MAX_FILES = 400;
/** How deep the folders go: a render lands in outputs/<project>/<piece>/exports/<version>/ (Arun, 2026-10-26: its video wasn't in Media). */
const MAX_DEPTH = 8;
/** At most this many files looked at, so a folder of thousands of frames doesn't hold the list up. */
const MAX_SEEN = 6000;
/**
 * And at most this many entries of any kind (folders and files that aren't pieces too), and this long: an agent working in the
 * home folder would otherwise have its Library read every few seconds, as the panels ask (Arun, 2026-10-28: "iron everything and
 * ensure we are good… any logic errors").
 */
const MAX_ENTRIES = 40_000;
const MAX_MS = 1_500;
/** A listing is kept this long, so the panels' asking every few seconds, and two panels asking at once, walk the folders once. */
const LIST_TTL_MS = 3_000;
const listed = new Map<string, { at: number; files: Promise<WorkFile[]> }>();

export const workKind = (file: string): WorkKind | undefined => KINDS[path.extname(file).toLowerCase()];

/** A path inside a folder as the panels and agents name it: with forward slashes, on Windows too. */
const slashed = (rel: string) => rel.split(path.sep).join("/");

/** The pieces in each folder, newest first across all of them: walked at most every few seconds, the same answer meanwhile. */
export function listWork(roots: string[], limits: { entries?: number; ms?: number } = {}): Promise<WorkFile[]> {
  const key = JSON.stringify([roots, limits]);
  const had = listed.get(key);
  if (had && Date.now() - had.at < LIST_TTL_MS) return had.files;
  const files = walkWork(roots, limits.entries ?? MAX_ENTRIES, limits.ms ?? MAX_MS);
  if (listed.size > 50) listed.clear();
  listed.set(key, { at: Date.now(), files });
  // A walk that failed is not kept.
  files.catch(() => listed.get(key)?.files === files && listed.delete(key));
  return files;
}

async function walkWork(roots: string[], maxEntries: number, maxMs: number): Promise<WorkFile[]> {
  const found: WorkFile[] = [];
  let seen = 0;
  let entriesSeen = 0;
  const t0 = Date.now();
  const enough = () => seen >= MAX_SEEN || entriesSeen >= maxEntries || Date.now() - t0 > maxMs;
  const walk = async (root: number, dir: string, depth: number): Promise<void> => {
    if (enough()) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (enough()) return;
      entriesSeen++;
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP.has(e.name)) await walk(root, p, depth + 1);
        continue;
      }
      const kind = e.isFile() ? workKind(e.name) : undefined;
      if (!kind) continue;
      seen++;
      try {
        const s = await stat(p);
        found.push({ root, path: slashed(path.relative(roots[root]!, p)), kind, size: s.size, mtime: s.mtimeMs, ...(kind === "doc" ? await summary(p, s.size, s.mtimeMs) : {}) });
      } catch {
        // Gone between the listing and the look.
      }
    }
  };
  for (let i = 0; i < roots.length; i++) await walk(i, roots[i]!, 0);
  return frameRuns(found).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

/**
 * A long run of numbered pictures in one folder (a render's every frame) as its first one, with how many there are, so it can't
 * crowd everything else out of the list. A shorter run (pilot-f000-v002 … pilot-f610-v002) comes whole: the panel shows it as a set.
 */
function frameRuns(files: WorkFile[]): WorkFile[] {
  const runs = new Map<string, WorkFile[]>();
  const out: WorkFile[] = [];
  for (const f of files) {
    const at = f.path.lastIndexOf("/") + 1;
    if (f.kind !== "image" || !/\d/.test(f.path.slice(at))) {
      out.push(f);
      continue;
    }
    const key = `${f.root}|${f.path.slice(0, at)}${f.path.slice(at).replace(/\d+/g, "#")}`;
    runs.set(key, [...(runs.get(key) ?? []), f]);
  }
  for (const run of runs.values()) {
    if (run.length < 60) {
      out.push(...run);
      continue;
    }
    run.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    out.push({ ...run[0]!, frames: run.length, mtime: Math.max(...run.map((f) => f.mtime)) });
  }
  return out;
}

/**
 * A path on another computer, or one the system would reach the network for: a Windows share (\\host\share, //host/share),
 * a device path (\\?\ or \\.\), or macOS's automounted /net and /Network. Asking the disk about one (realpath, stat) connects
 * to it, and on Windows hands that computer the person's sign-in hash: refused before anything asks.
 */
export function networkPath(p: string): boolean {
  return /^[\\/]{2}/.test(p) || /^\/(net|Network)(\/|$)/i.test(p);
}

/** `full` is inside `base` (not `base` itself), by path alone: a drive's root as `base` too, and `..foo` is a name, not a way up. */
export function inside(base: string, full: string): boolean {
  const r = path.relative(base, full);
  return !!r && r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
}

/** A file in one of the folders, by its path there: never one outside it, by `..`, an absolute path or a link. */
export async function workPath(root: string, rel: string): Promise<string | null> {
  if (!rel || networkPath(root) || networkPath(rel) || rel.includes("\0")) return null;
  // Inside the folder as written, before the disk is asked anything; then again once links are followed.
  const lexical = path.resolve(root, rel);
  if (!inside(path.resolve(root), lexical) || !workKind(lexical)) return null;
  try {
    const base = await realpath(root);
    const full = await realpath(lexical);
    return inside(base, full) && workKind(full) ? full : null;
  } catch {
    return null;
  }
}

/** Where the agents' browser keeps its screenshots (local/desktop-browser.ts): pictures an agent shows in the chat. */
export const shotsDir = (): string => path.join(process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday"), "shots");

/**
 * A picture or video an agent shows in the chat by its full path (a screenshot it took, an image it made), which needn't be in
 * its folder: one in the session's folders (`roots`) or Friday's screenshots, or one the session's log names (`named`, asked only
 * when it is neither). Never anything else (no text, no documents), never a folder, never a path on another computer.
 */
export async function shownFile(abs: string, roots: string[] = [], named: (abs: string) => boolean | Promise<boolean> = () => false): Promise<string | null> {
  if (!path.isAbsolute(abs) || networkPath(abs) || abs.includes("\0")) return null;
  const kindOf = (p: string) => workKind(p) === "image" || workKind(p) === "video";
  if (!kindOf(abs)) return null;
  try {
    const full = await realpath(abs);
    if (!kindOf(full) || !(await stat(full)).isFile()) return null;
    for (const r of [...roots, shotsDir()]) {
      if (networkPath(r)) continue;
      const base = await realpath(r).catch(() => null);
      if (base && inside(base, full)) return full;
    }
    return (await named(abs)) ? full : null;
  } catch {
    return null;
  }
}

/**
 * Whether the session's log names `abs` (as said, or as a link spells it), in what its agents or people wrote: a picture shown
 * in the chat by its path. `bodies`: each event's body as JSON.
 */
export function namedIn(bodies: Iterable<string>, abs: string): boolean {
  const asJson = JSON.stringify(abs).slice(1, -1);
  const asLink = JSON.stringify(encodeURI(abs)).slice(1, -1);
  for (const b of bodies) if (b.includes(asJson) || b.includes(asLink)) return true;
  return false;
}

/** A path parameter as sent: not trimmed (a name can start or end with a space), cut by characters, never mid-character. */
export const pathParam = (v: string | null, max: number): string => Array.from(v ?? "").slice(0, max).join("");

/** The file itself, in ranges when asked (a video seeking). */
export async function serveWork(req: http.IncomingMessage, res: http.ServerResponse, file: string): Promise<void> {
  const { size } = await stat(file);
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  // An SVG or a text file opened on its own runs nothing: a piece of writing is never a page of the app's.
  const inert = type.startsWith("text/") || type === "image/svg+xml";
  const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(inert ? { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" } : {}) };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    stream(file, res, { start, end });
    return;
  }
  res.writeHead(200, { ...head, "Content-Length": size });
  stream(file, res);
}

/** A file to the response; one that goes (or can't be read) after its size was sent ends the response, never the process. */
function stream(file: string, res: http.ServerResponse, range?: { start: number; end: number }): void {
  const s = createReadStream(file, range);
  s.on("error", () => res.destroy());
  res.on("close", () => s.destroy());
  s.pipe(res);
}

/**
 * A site's own icon, for the Sources the agents read (client/WorkRail.tsx; Arun, 2026-10-26: "can we actually fetch the sites
 * favicon"): asked of the site itself, never of an icon service, so nobody else learns what the session read. The icon its home
 * page names (the largest), else /favicon.ico; kept for a day, a site without one too. Only public sites: never this computer or
 * its network, by name or by what the name points at.
 */
const icons = new Map<string, { at: number; icon: { type: string; body: Buffer } | null }>();
const ICON_MAX = 256 * 1024;

export const privateAddress = (ip: string) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(ip) || /^(::|f[cdf]|fe[89ab])/i.test(ip);

/** A name a public site could have: not an address of this computer's or its network's, nor a name only the network gives. */
const publicName = (host: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !/\.(local|localhost|internal|lan|home|arpa)$/i.test(host) && !(isIP(host) && privateAddress(host));

async function publicHost(host: string): Promise<boolean> {
  if (!publicName(host)) return false;
  if (isIP(host)) return true;
  const all = await new Promise<LookupAddress[]>((resolve) => dnsLookup(host, { all: true }, (err, a) => resolve(err ? [] : a)));
  return all.length > 0 && all.every((a) => !privateAddress(a.address));
}

/**
 * The name looked up for the connection itself, refused when any address it has is private: the address checked is the one
 * connected to, so a name that answers a public address to the check and this computer's to the fetch can't get through.
 */
export function publicLookup(host: string, opts: { family?: number | string; all?: boolean; hints?: number }, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  const family = opts.family === "IPv4" ? 4 : opts.family === "IPv6" ? 6 : typeof opts.family === "number" ? opts.family : 0;
  dnsLookup(host, { all: true, family, ...(opts.hints ? { hints: opts.hints } : {}) }, (err, all) => {
    if (err) return cb(err, "");
    if (!all.length || all.some((a) => privateAddress(a.address))) return cb(Object.assign(new Error(`${host} isn't a public site`), { code: "ENOTFOUND" }), "");
    if (opts.all) cb(null, all);
    else cb(null, all[0]!.address, all[0]!.family);
  });
}

/** The next address to ask, after `from` sent `to`: only https on a public name; null for anything else. */
export function nextHop(from: string, to: string): string | null {
  try {
    const u = new URL(to, from);
    return u.protocol === "https:" && !u.username && !u.password && publicName(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/** One GET, its redirects followed by hand: each hop checked as the first was, each connection to a checked address only. */
async function fetchSome(url: string, accept: string): Promise<{ type: string; body: Buffer; url: string } | null> {
  const signal = AbortSignal.timeout(4000);
  let at: string | null = nextHop(url, url);
  for (let hops = 0; at && hops <= 4; hops++) {
    const r = await getOnce(at, accept, signal);
    if (!r) return null;
    if (r.location !== undefined) {
      at = nextHop(at, r.location);
      continue;
    }
    return r.status >= 200 && r.status < 300 ? { type: r.type, body: r.body, url: at } : null;
  }
  return null;
}

function getOnce(url: string, accept: string, signal: AbortSignal): Promise<{ status: number; type: string; body: Buffer; location?: string } | null> {
  return new Promise((resolve) => {
    let req: http.ClientRequest;
    try {
      req = https.get(url, { headers: { Accept: accept, "User-Agent": "Mozilla/5.0 (Macintosh) Friday" }, lookup: publicLookup as never, signal }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve(res.headers.location ? { status, type: "", body: Buffer.alloc(0), location: res.headers.location } : null);
        }
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          n += c.length;
          if (n > ICON_MAX) res.destroy();
        });
        const done = () => resolve({ status, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      });
    } catch {
      return resolve(null);
    }
    req.on("error", () => resolve(null));
  });
}

export async function siteIcon(host: string): Promise<{ type: string; body: Buffer } | null> {
  host = host.toLowerCase().replace(/^www\./, "");
  const had = icons.get(host);
  if (had && Date.now() - had.at < 86_400_000) return had.icon;
  let icon: { type: string; body: Buffer } | null = null;
  if (await publicHost(host)) {
    const tries: string[] = [];
    const home = await fetchSome(`https://${host}/`, "text/html");
    if (home && /html/i.test(home.type)) {
      const html = home.body.toString("utf8");
      const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((l) => /\brel=["']?[^"'>]*\bicon\b/i.test(l));
      // The largest it says it has, an apple-touch-icon counted as 180.
      const size = (l: string) => Math.max(...(/\bsizes=["']?(\d+)/i.exec(l) ? [Number(/\bsizes=["']?(\d+)/i.exec(l)![1])] : [/apple-touch/i.test(l) ? 180 : 16]));
      for (const l of links.sort((a, b) => size(b) - size(a))) {
        const href = /\bhref=["']?([^"'\s>]+)/i.exec(l)?.[1];
        if (href && !href.startsWith("data:")) tries.push(new URL(href.replace(/&amp;/g, "&"), home.url).href);
      }
    }
    tries.push(`https://${host}/favicon.ico`);
    for (const u of tries.slice(0, 4)) {
      const got = /^https:\/\//i.test(u) ? await fetchSome(u, "image/*") : null;
      if (got && /^image\//i.test(got.type) && got.body.length > 0 && got.body.length <= ICON_MAX) {
        icon = { type: got.type.split(";")[0]!, body: got.body };
        break;
      }
    }
  }
  if (icons.size > 500) icons.clear();
  icons.set(host, { at: Date.now(), icon });
  return icon;
}
