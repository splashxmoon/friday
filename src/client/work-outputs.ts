/**
 * What a Work session's rail counts as its outputs, its collections and the apps its agents used (WorkRail.tsx), apart from the
 * page so it can be tested: no styles, nothing drawn.
 *
 */
import type { SessionState } from "../session/projection.js";
import type { SessionEvent } from "../types.js";
import { MAIN_LANE } from "../types.js";
import type { WorkFile, WorkList } from "./WorkPanels.js";
import type { BoardCard } from "../board.js";
import { limitHit, signedOut } from "../limit-reset.js";

const name = (p: string) => p.split("/").pop() ?? p;
export const isSourcesFile = (f: WorkFile) => name(f.path) === "sources.md";
export const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");

const pretty = (dir: string) => {
  const words = (dir.split("/").pop() ?? dir).replace(/^\d+[-_ ]+/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : dir;
};

/**
 * The file that makes a folder a collection: made by an agent only when the person asks for one (Arun, 2026-10-27: "hubs are only
 * created when asked for"), never guessed from a folder's size or its README.
 */
const HOME = /^(collection|hub)\.md$/i;

export interface Hub {
  root: number;
  dir: string;
  title: string;
  about: string;
  home?: WorkFile;
  files: WorkFile[];
  mtime: number;
}

/** A summary cut short (the folder's reading keeps 240 characters) ends at a word, with "…", never mid-word. */
export const clipAbout = (s: string, max = 240): string => {
  if (s.length < max) return s;
  const cut = s.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s,;:.-]+$/, "");
  return `${cut}…`;
};

/** The collections among the outputs: each folder with a collection.md of its own, never one inside another. */
export function hubsIn(files: WorkFile[]): Hub[] {
  const found: Hub[] = [];
  for (const home of files.filter((f) => HOME.test(name(f.path)) && f.path.includes("/"))) {
    const dir = dirOf(home.path);
    const inside = files.filter((f) => f.root === home.root && f.path.startsWith(`${dir}/`) && !isSourcesFile(f));
    found.push({ root: home.root, dir, title: home.title || pretty(dir), about: clipAbout(home.excerpt ?? ""), home, files: inside, mtime: Math.max(...inside.map((f) => f.mtime)) });
  }
  found.sort((a, b) => a.dir.split("/").length - b.dir.split("/").length);
  const kept: Hub[] = [];
  for (const h of found) if (!kept.some((k) => k.root === h.root && h.dir.startsWith(`${k.dir}/`))) kept.push(h);
  return kept.sort((a, b) => b.mtime - a.mtime);
}

/**
 * A picture or video named in a message, as the chat shows it (AnswerParts MediaChip): in backticks (spaces and all), as Markdown
 * (`![x](a.png)`, or `![x](<a b.png>)` for a name with spaces), or as a bare path, whose folders and name hold no spaces, so
 * "renders/hero.png and renders/alt.png" is two pictures, not one. Letters in any script: `héro.png` is a picture too (Arun,
 * 2026-10-28: "iron everything and ensure we are good… focusing on UI and UX and any logic errors").
 */
const MEDIA = "(?:png|jpe?g|gif|webp|avif|svg|mp4|mov|webm|m4v)";
const BIT = "[\\p{L}\\p{N}\\p{M}_.@~+-]+";
const SENT = new RegExp(
  [
    `\`([^\`\\n]*?\\.${MEDIA})\``,
    `!\\[[^\\]]*\\]\\((?:<([^>\\n]+?\\.${MEDIA})>|([^)\\s]+\\.${MEDIA}))(?:\\s+"[^"]*")?\\)`,
    `(?:^|(?<=[\\s(]))((?:~|\\.{1,2})?\\/?${BIT}(?:\\/${BIT})*\\.${MEDIA})(?=[\\s.,;:!?)]|$)`,
  ].join("|"),
  "gimu",
);

/** The pictures and videos the agents showed in the chat, as the paths they named them by. */
export function sentIn(events: SessionEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) for (const p of sentBy(e)) out.add(p);
  return [...out];
}

/**
 * What one event says, read once: an event never changes, so the rail and the bar, on every live event, look each one up rather
 * than reading the whole log again (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
 */
function once<T>(read: (e: SessionEvent) => T): (e: SessionEvent) => T {
  const kept = new WeakMap<SessionEvent, T>();
  return (e) => {
    if (kept.has(e)) return kept.get(e)!;
    const v = read(e);
    kept.set(e, v);
    return v;
  };
}

const sentBy = once((e): string[] => {
  if (e.body.type !== "agent.message" || !e.body.text) return [];
  const out: string[] = [];
  for (const m of e.body.text.matchAll(SENT)) {
    const p = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (p) out.push(p.replace(/^\.\//, ""));
  }
  return out;
});

/** Whether a file is one of those: by its full path, or the end of it an agent named from its own folder. */
const wasSent = (sent: string[], roots: string[], f: WorkFile) => {
  // The same letters, however they were stored: macOS may keep `héro.png` decomposed while the chat says it composed.
  const full = `${roots[f.root] ?? ""}/${f.path}`.normalize("NFC");
  const own = f.path.normalize("NFC");
  return sent.some((said) => {
    const p = said.normalize("NFC");
    return p === full || p === own || full.endsWith(`/${p.replace(/^~\//, "")}`) || (p.includes("/") && own.endsWith(p));
  });
};

/** A finished video by its name: final, master, delivery or deliverable. */
const FINAL = /(^|[\/_. -])(final|master|deliver(y|able)?s?)([\/_. -]|$)/i;

/**
 * What Outputs holds (Arun, 2026-10-27: "only have sent images, no voices, since that will be in chat, also only final videos;
 * everything else can be sent in chat and saved there"): the writing, pages and sheets the agents saved; the pictures they showed
 * in the chat; and finished videos, shown in the chat or named final. No audio, and no frames, takes or drafts.
 */
export function outputsOf(work: WorkList, sent: string[]): WorkFile[] {
  return work.files.filter((f) => {
    if (isSourcesFile(f) || f.kind === "audio") return false;
    if (f.kind === "doc") return true;
    if (wasSent(sent, work.roots, f)) return true;
    return f.kind === "video" && FINAL.test(f.path);
  });
}

/** An MCP server's name as people say it: claude_ai_Gmail is Gmail, google-drive is Google drive. */
const serverName = (s: string) => {
  const w = s.replace(/^claude_ai_/i, "").replace(/[-_]+/g, " ").trim();
  return w ? w[0]!.toUpperCase() + w.slice(1) : s;
};

/**
 * The MCP servers the agents called this session (both tools log a call as mcp__<server>__<tool>), most used first: how often,
 * which of their tools, by whom, and when last. Friday's own server and Claude in Chrome have rows of their own.
 */
export function mcpUsed(events: SessionEvent[], names: Map<string, string>): { server: string; name: string; calls: number; tools: string[]; by: string[]; at: number }[] {
  const seen = new Map<string, { calls: number; tools: Set<string>; by: Set<string>; at: number }>();
  for (const e of events) {
    if (e.body.type !== "agent.message") continue;
    for (const c of e.body.toolCalls) {
      const m = /^mcp__(.+?)__(.+)$/.exec(c.name);
      if (!m || /^(friday|claude-in-chrome)$/.test(m[1]!)) continue;
      const u = seen.get(m[1]!) ?? { calls: 0, tools: new Set<string>(), by: new Set<string>(), at: 0 };
      u.calls++;
      u.tools.add(m[2]!.replace(/_/g, " "));
      u.by.add(names.get(e.lane ?? MAIN_LANE) ?? e.actor.name);
      u.at = Math.max(u.at, e.ts);
      seen.set(m[1]!, u);
    }
  }
  return [...seen]
    .map(([server, u]) => ({ server, name: serverName(server), calls: u.calls, tools: [...u.tools], by: [...u.by], at: u.at }))
    .sort((a, b) => b.calls - a.calls);
}

// ── reading the folder's pieces (WorkPanels.tsx, WorkRail.tsx), apart from the page so it can be tested ──

/** `%E2%9C%93` as `✓`, and `50%off` as it is: a stray % in a link an agent wrote is no reason to stop drawing the document. */
export const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A path a piece links to, from the folder the piece is in: `../brief.md` from `drafts/x.md` is `brief.md`. */
export function resolveFrom(from: string, href: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const bit of href.split("#")[0]!.split("?")[0]!.split("/")) {
    if (!bit || bit === ".") continue;
    if (bit === "..") parts.pop();
    else parts.push(safeDecode(bit));
  }
  return parts.join("/");
}

/** A path from the folder's top as a link: each part encoded whole, so a `#` or `?` in a name is part of the name. */
export const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/**
 * Links to the folder's own files (`brief.md`, `../notes/x.md`, `<my notes.md>`) as paths from the folder's top (`/notes/x.md`):
 * the renderer's link check passes a relative link only once it can tell it is one, and then reads it from the top, not from the
 * piece's own folder. Code is left as it was written: a `](x)` in a code block is code, not a link.
 */
export function fromTop(text: string, from: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\]\((?![a-z][a-z0-9+.-]*:|#|<[a-z][a-z0-9+.-]*:)(<[^>\n]+>|[^)\s]+)/gi, (_, at: string) => {
            const to = at.startsWith("<") ? at.slice(1, -1) : at;
            return `](/${encodePath(to.startsWith("/") ? safeDecode(to.slice(1)) : resolveFrom(from, to))}`;
          }),
    )
    .join("");
}

/**
 * The folder's file a path named in the chat means, by the closest match: the path itself, then its full path on this computer,
 * then the file whose path ends in it, the one nearest the top of the folder, newest first. `README.md` is `README.md`, never
 * `notes/README.md` just because the folder listed that one first.
 */
export function matchFile(list: Pick<WorkList, "roots" | "files">, asked: string): WorkFile | null {
  const want = asked.replace(/^\.\//, "").normalize("NFC");
  const full = (x: WorkFile) => `${list.roots[x.root] ?? ""}/${x.path}`.normalize("NFC");
  const exact = list.files.find((x) => x.path.normalize("NFC") === want);
  if (exact) return exact;
  const whole = list.files.find((x) => full(x) === want);
  if (whole) return whole;
  const ends = list.files.filter((x) => full(x).endsWith(`/${want}`));
  ends.sort((a, b) => a.path.split("/").length - b.path.split("/").length || b.mtime - a.mtime);
  return ends[0] ?? null;
}

/** The pictures a gallery steps through for one: those in its folder, in order, the picture itself always among them. */
export function galleryOf(f: WorkFile, among: WorkFile[]): { files: WorkFile[]; at: number } {
  const same = (x: WorkFile) => x.root === f.root && x.path === f.path;
  const stills = among.filter((x) => x.kind === "image" && x.root === f.root && dirOf(x.path) === dirOf(f.path) && !same(x));
  stills.push(f);
  stills.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { files: stills, at: stills.findIndex(same) };
}

/** A sheet's rows that say every word looked for, each with its number in the sheet; drawn no more than `cap` at once. */
export function sheetRows(body: string[][], find: string, cap: number): { rows: { cells: string[]; at: number }[]; total: number } {
  const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = body.map((cells, at) => ({ cells, at }));
  const hits = words.length ? all.filter((r) => words.every((w) => r.cells.join(" ").toLowerCase().includes(w))) : all;
  return { rows: hits.slice(0, cap), total: hits.length };
}

/** What a folder listing is, as the server says it. */
export type Listed = { roots?: string[]; files?: WorkFile[]; error?: string };

/** The same files, as far as anything showing them can tell: kept as the object it was, so nothing draws again for nothing. */
const sig = (l: Pick<WorkList, "roots" | "files">) => `${l.roots.join("\n")}\n${l.files.map((f) => `${f.root}|${f.path}|${f.mtime}|${f.size}`).join("\n")}`;

/**
 * One session's folder listing, asked again every few seconds by whatever shows it (useWork): one asking at a time, so a folder
 * slow to read never piles them up; an answer older than one already taken is dropped, so a file deleted never comes back; and a
 * listing that failed says so rather than looking empty.
 */
export function workPoller(ask: () => Promise<Listed>, heard: () => void) {
  const none: WorkList = { roots: [], files: [], error: "", loaded: false };
  let got = none;
  let asked = 0;
  let taken = 0;
  let busy: Promise<void> | null = null;
  const look = (force = false): Promise<void> => {
    if (busy && !force) return busy;
    const n = ++asked;
    const run = ask()
      .then((r) => {
        if (n < taken) return;
        taken = n;
        const next: WorkList = { roots: r.roots ?? [], files: r.files ?? [], error: r.error ?? "", loaded: true };
        if (got.loaded && !next.error && !got.error && sig(next) === sig(got)) return;
        got = next.error ? { ...got, error: next.error, loaded: true } : next;
        heard();
      })
      .catch((e: Error) => {
        if (n < taken) return;
        taken = n;
        if (got.error === e.message && got.loaded) return;
        got = { ...got, error: e.message || "The folder couldn't be read.", loaded: true };
        heard();
      })
      .finally(() => {
        if (busy === run) busy = null;
      });
    busy = run;
    return run;
  };
  return { look, get: () => got };
}

/** A link outside the folder: a scheme of its own (https:, data:, mailto:). */
export const OUTSIDE = /^[a-z][a-z0-9+.-]*:/i;
/** What a page an agent made loads from beside it in the folder: its pictures, video, a stylesheet. */
export const PAGE_REFS = /\b(src|href|poster)=(["'])([^"']+)\2/gi;
/** Whether a page's reference is to the folder: not the web, not a place in the page, not another host. */
export const inFolderRef = (to: string) => !OUTSIDE.test(to) && !to.startsWith("#") && !to.startsWith("//");
/** A page's reference as a path from the folder's top. */
export const pageRef = (page: string, to: string) => resolveFrom(to.startsWith("/") ? "" : page, to.replace(/^\//, ""));

/**
 * The one folder a page needs read for it to show (its own, or the one its `../pictures/` are in): what the frame's pass is good
 * for (work-frame.ts), and nothing wider.
 */
export function frameScope(page: string, html: string): string {
  const dirs = [dirOf(page)];
  for (const m of html.matchAll(PAGE_REFS)) if (inFolderRef(m[3]!)) dirs.push(dirOf(pageRef(page, m[3]!)));
  const split = dirs.map((d) => (d ? d.split("/") : []));
  const first = split[0]!;
  let n = first.length;
  for (const d of split) {
    let i = 0;
    while (i < n && d[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join("/");
}

/**
 * A web page or search the agents reached for, from their tool calls and what those calls turned up. Pages are numbered in the
 * order they were first read, as a cited answer numbers them ([1], [2]…): the count of pages is the count of sources everywhere
 * it is said (the rail, the folded tile, the bar along the foot, a reply's own "2 sources"), and a page a search turned up says
 * which search (`of`), so the rail lists it under that search (Arun, 2026-10-28: "iron everything… focusing on UI and UX"; the
 * 2026-10-28 critique: "Sources should read like Perplexity, not a URL log"; w2: "Sources leaves out the pages an answer cites").
 */
export interface Source {
  kind: "search" | "page";
  /** A search's words; a page's host and path (`news.ycombinator.com/item?id=1`). */
  text: string;
  url?: string;
  /** A page's own title, when its search or its reading gave one. */
  title?: string;
  /** A page's number, from 1, in the order the pages were first read. */
  n?: number;
  /** The words of the search that turned a page up. */
  of?: string;
  at: number;
  by: string;
}

const URL_RE = /^https?:\/\//i;
/** One page however it was written: `https://x.com/a/` and `https://x.com/a#top` are `https://x.com/a`. */
const pageKey = (url: string) => url.replace(/#.*$/, "").replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
const shortUrl = (url: string) => url.replace(URL_RE, "").replace(/\/+$/, "");

/** A page's title as reading it said: a `Title:` line, a first Markdown heading, or its <title>. */
export function titleIn(output: string): string | undefined {
  const head = output.slice(0, 4000);
  const t = /^\s*title\s*:\s*(.+)$/im.exec(head)?.[1] ?? /<title[^>]*>([^<]{1,200})<\/title>/i.exec(head)?.[1] ?? /^#\s+(.+)$/m.exec(head)?.[1];
  const clean = t?.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  return clean && clean.length <= 160 ? clean : undefined;
}

/**
 * The pages in a search's output, with their titles where the search gave them (as the chat's "N sources" reads them,
 * web-sources.ts): `{"title","url"}` pairs, `[Title](https://…)`, `- Title https://…`, then any bare address. Each page once.
 */
export function pagesIn(output: string): { url: string; title?: string }[] {
  const found = new Map<string, string | undefined>();
  const add = (raw: string, title?: string) => {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (!URL_RE.test(url)) return;
    const t = title?.replace(/\s+/g, " ").trim();
    if (!found.has(url) || (!found.get(url) && t)) found.set(url, t || found.get(url));
  };
  const unescape = (raw: string) => {
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  };
  try {
    for (const m of output.matchAll(/\{[^{}]*?"title"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?"url"\s*:\s*"([^"]+)"[^{}]*?\}/g)) add(m[2]!, unescape(m[1]!));
    for (const m of output.matchAll(/\{[^{}]*?"url"\s*:\s*"([^"]+)"[^{}]*?"title"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?\}/g)) add(m[1]!, unescape(m[2]!));
    for (const m of output.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) add(m[2]!, m[1]);
    for (const m of output.matchAll(/^\s*[-*]\s+(.+?)\s+(https?:\/\/\S+)\s*$/gm)) add(m[2]!, m[1]);
    for (const m of output.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) add(m[0]);
  } catch {
    // What was found before the surprise still counts.
  }
  return [...found].map(([url, title]) => (title ? { url, title } : { url }));
}

/** What an event's tool calls reached, read once (as sentBy): a search and its words, or a page and its address. */
const reachedBy = once((e): { id: string; kind: "search" | "page"; text: string; url?: string; key?: string; at: number }[] => {
  if (e.body.type !== "agent.message") return [];
  const out: { id: string; kind: "search" | "page"; text: string; url?: string; key?: string; at: number }[] = [];
  for (const c of e.body.toolCalls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.arguments || "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const query = typeof args.query === "string" ? args.query : typeof args.searchTerm === "string" ? args.searchTerm : "";
    const url = typeof args.url === "string" && URL_RE.test(args.url) ? args.url : "";
    // A search in a connected app (mail, Notion) is not the web: Connectors counts those. Claude in Chrome's pages are
    // (mcp__claude-in-chrome__navigate). Nor is a coding tool looking up its own tools (Claude Code's ToolSearch, "select:…").
    const web = (!c.name.startsWith("mcp__") || /web|search_engine|browser|fetch|chrome|navigate/i.test(c.name)) && !/^tool_?search$/i.test(c.name) && !/^select:/i.test(query);
    if (!web) continue;
    if (/search/i.test(c.name) && query) out.push({ id: c.id, kind: "search", text: query, at: e.ts });
    else if (url) out.push({ id: c.id, kind: "page", text: shortUrl(url), url, key: pageKey(url), at: e.ts });
  }
  return out;
});

/** What one tool's answer says of the web, read once (as sentBy): the page's title, and the pages a search turned up. */
const titleOf = once((e): string | undefined => (e.body.type === "tool.result" ? titleIn(e.body.output) : undefined));
const pagesOf = once((e) => (e.body.type === "tool.result" ? pagesIn(e.body.output).map((p) => ({ ...p, key: pageKey(p.url) })) : []));

/** The last answer, for the same log: the rail, its bar and the browser panel each ask on every live event. */
let lastSources: { events: SessionEvent[]; lanes: SessionState["lanes"]; out: Source[] } | null = null;

/**
 * The web the agents read this session, in the order they read it: each search, then the pages it turned up, numbered.
 *
 * Read on every live event, over the whole log: each call and each answer is read once and kept (once), so a long session
 * costs a pass of lookups rather than every search's output parsed again (Arun, 2026-10-30: "the app feel laggy when
 * running a lot of tasks and agents"; 10,000 steps had it at a quarter of the page's time).
 */
export function sourcesIn(events: SessionEvent[], state: SessionState): Source[] {
  if (lastSources && lastSources.events === events && lastSources.lanes === state.lanes) return lastSources.out;
  // What each call gave back, for a search's pages and a page's title.
  const results = new Map<string, SessionEvent>();
  for (const e of events) if (e.body.type === "tool.result" && !e.body.isError) results.set(e.body.callId, e);
  const names = new Map(state.lanes.map((l) => [l.id, l.name]));
  const pages = new Map<string, Source>();
  const searches = new Set<string>();
  const out: Source[] = [];
  const page = (url: string, key: string, at: number, by: string, title?: string, of?: string) => {
    const had = pages.get(key);
    if (had) {
      if (!had.title && title) had.title = title;
      return;
    }
    const s: Source = { kind: "page", text: shortUrl(url), url, at, by, n: pages.size + 1, ...(title ? { title } : {}), ...(of ? { of } : {}) };
    pages.set(key, s);
    out.push(s);
  };
  for (const e of events) {
    const reached = reachedBy(e);
    if (!reached.length) continue;
    const by = (e.lane ? names.get(e.lane) : undefined) ?? e.actor.name;
    for (const r of reached) {
      const said = results.get(r.id);
      if (r.kind === "page") {
        page(r.url!, r.key!, r.at, by, said ? titleOf(said) : undefined);
        continue;
      }
      const key = r.text.trim().toLowerCase();
      if (!searches.has(key)) {
        searches.add(key);
        out.push({ kind: "search", text: r.text, at: r.at, by });
      }
      for (const p of said ? pagesOf(said) : []) page(p.url, p.key, r.at, by, p.title, r.text);
    }
  }
  lastSources = { events, lanes: state.lanes, out };
  return out;
}

/** How many sources there are, as every place that counts them says it: the pages read, else the searches made. */
export const sourceCount = (sources: Source[]): { n: number; word: "source" | "search" } => {
  const pages = sources.filter((s) => s.kind === "page").length;
  return pages ? { n: pages, word: "source" } : { n: sources.length, word: "search" };
};

// ── words a person reads (WorkRail.tsx), apart from the page so they can be tested ──

/** A line an agent wrote, as words: "## Tuning results" is "Tuning results", "Done: I added a **Notes** section" loses its stars. */
export function plainLine(s: string): string {
  return s
    .replace(/```[a-z]*\n?|```/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How many words a written piece has, as the rail's card and the reader both say it: its front matter and code blocks left out,
 * and only what has a letter or a digit in it counted, so a "-" or a "#" is no word. The two counted differently and disagreed
 * (3,145 against 3,421; Arun, 2026-10-28: "iron everything and ensure we are good"). The server counts with this too (work-files.ts).
 */
export function wordCount(text: string): number {
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  const body = front ? text.slice(front[0].length) : text;
  // Chinese and Japanese are written without spaces, so each of their characters is a word, as word processors count them:
  // "日本語のメモ" was 1 word (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\s+/)
    .reduce((n, w) => {
      const cjk = w.match(CJK)?.length ?? 0;
      return n + cjk + (/[\p{L}\p{N}]/u.test(w.replace(CJK, "")) ? 1 : 0);
    }, 0);
}
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/**
 * A written piece's title as its heading says it: the first `#` or `##` heading after any front matter, its marks still in. One
 * rule for the rail's card (the server's summary, work-files.ts), the chat's chips and the reader's head: the reader read only a
 * `#` and called a piece "README" that the rail and its chip called "Notes" (Arun, 2026-10-28: "iron everything and ensure we
 * are good").
 */
export function headingOf(text: string): string | undefined {
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  const body = front ? text.slice(front[0].length) : text;
  return body.split(/\r?\n/).find((l) => /^#{1,2}\s+\S/.test(l))?.replace(/^#+\s+/, "");
}

/** A file's name as a title: `shot-plan.csv` is "Shot plan", `02_art_direction.md` is "Art direction". */
export function fileTitle(file: string): string {
  const n = name(file);
  const words = n.replace(/\.[^.]+$/, "").replace(/^\d+[-_ ]+/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : n;
}

/** What a piece is called wherever a person reads it: its own title (a heading, a page's <title>), else its name as words. */
export const pieceTitle = (f: Pick<WorkFile, "path" | "title">): string => (f.title?.trim() ? plainLine(f.title) : fileTitle(f.path));

/**
 * The pieces whose title another in the same list has too (two "Notes": README.md and notes.txt): these say their file name as
 * well, so they can be told apart (w1 #6).
 */
export function sameTitled(files: Pick<WorkFile, "root" | "path" | "title">[]): Set<string> {
  const by = new Map<string, number>();
  for (const f of files) by.set(pieceTitle(f).toLowerCase(), (by.get(pieceTitle(f).toLowerCase()) ?? 0) + 1);
  return new Set(files.filter((f) => (by.get(pieceTitle(f).toLowerCase()) ?? 0) > 1).map((f) => `${f.root}|${f.path}`));
}

/** What a collection holds, as its card and its page both count it: not its own home page (collection.md), nor its sources. */
export const hubPieces = (hub: Pick<Hub, "files" | "home">): WorkFile[] => hub.files.filter((f) => f !== hub.home && !(hub.home && f.root === hub.home.root && f.path === hub.home.path) && !isSourcesFile(f));

/**
 * What the agents drew in the chat (a ```html page, an ```svg drawing, a ```mermaid diagram, LiveBlock.tsx), for Outputs'
 * "Shown in chat": each with its own title (a <title>, a first heading, a diagram's title) where it says one, the message it is
 * in and which of that message's drawings it is (the 2026-10-28 critique: "Whatever the agent shows in chat never reaches Outputs").
 */
export interface Shown {
  seq: number;
  /** Which of the message's drawings, from 0. */
  at: number;
  kind: "html" | "svg" | "mermaid";
  title: string;
  ts: number;
}
const LIVE = /```(html|svg|mermaid)[^\n]*\n([\s\S]*?)```/gi;
const shownBy = once((e): Omit<Shown, "seq" | "ts">[] => {
  if (e.body.type !== "agent.message" || !e.body.text.includes("```")) return [];
  const out: Omit<Shown, "seq" | "ts">[] = [];
  for (const m of e.body.text.matchAll(LIVE)) {
    const kind = m[1]!.toLowerCase() as Shown["kind"];
    const code = m[2]!;
    const said =
      /<title[^>]*>([^<]{1,120})<\/title>/i.exec(code)?.[1] ??
      /<h[12][^>]*>([^<]{1,120})<\/h[12]>/i.exec(code)?.[1] ??
      /^\s*(?:---\s*\n\s*)?title\s*:?\s*(.{1,120})$/im.exec(code)?.[1];
    // Its own title first, then what the answer called it, then a label inside it (an <svg>'s first words are often one box's, "client").
    const clean = (t: string) => plainLine(t.replace(/&amp;/g, "&").replace(/&[a-z]+;/g, " "));
    const own = said ?? /\baria-label="([^"]{2,120})"/i.exec(code)?.[1];
    const inside = kind === "svg" ? /<text[^>]*>([^<]{3,80})<\/text>/i.exec(code)?.[1] : kind === "html" ? /<h[3-6][^>]*>([^<]{2,120})<\/h[3-6]>/i.exec(code)?.[1] : undefined;
    const title = own ? clean(own) : (leadIn(e.body.text.slice(0, m.index)) ?? (inside ? clean(inside) : drawnAs(kind, code)));
    out.push({ at: out.length, kind, title });
  }
  return out;
});
/**
 * What the answer called a drawing with no title of its own, from the line that led into it: "Here's how a session flows:" is
 * "How a session flows". Every one was "A diagram", "A drawing" or "A live page" (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY
 * VISUAL").
 */
function leadIn(before: string): string | undefined {
  const line = before.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (!line.endsWith(":") || line.length > 90 || line.startsWith("```")) return undefined;
  const words = plainLine(line.slice(0, -1))
    .replace(/^(?:so\s*,?\s*)?(?:here(?:'s| is| are)?|below is|this is|i(?:'ve)? (?:made|drew|drawn|sketched|put together|built)|i've got)\b\s*/i, "")
    .trim();
  return words.length >= 4 ? words[0]!.toUpperCase() + words.slice(1) : undefined;
}

/** A drawing's kind, said, when nothing names it: a mermaid diagram by what sort it is. */
function drawnAs(kind: Shown["kind"], code: string): string {
  if (kind === "svg") return "A drawing";
  if (kind === "html") return "A live page";
  const sort = /^\s*(?:%%[^\n]*\n\s*)*(\w+)/.exec(code)?.[1]?.toLowerCase() ?? "";
  const named: Record<string, string> = { flowchart: "A flowchart", graph: "A flowchart", sequencediagram: "A sequence diagram", classdiagram: "A class diagram", statediagram: "A state diagram", "statediagram-v2": "A state diagram", erdiagram: "An entity diagram", gantt: "A timeline", timeline: "A timeline", pie: "A pie chart", mindmap: "A mind map", journey: "A journey map", quadrantchart: "A quadrant chart", xychart: "A chart", "xychart-beta": "A chart", gitgraph: "A branch diagram", sankey: "A flow chart", "sankey-beta": "A flow chart" };
  return named[sort] ?? "A diagram";
}

export function shownIn(events: SessionEvent[]): Shown[] {
  const out: Shown[] = [];
  for (const e of events) for (const s of shownBy(e)) out.push({ ...s, seq: e.seq, ts: e.ts });
  return out.reverse();
}

/**
 * The titles of the folder's pieces, as the rail last read them (WorkRail), for the chat's file chips: `outputs/launch-week.html`
 * reads "Launch week content calendar" in a Work session (AnswerParts FileChip); one not read yet, by its name as words.
 *
 * Kept for each session, in this browser too, and said to the chips as they change: a chip drawn before the rail had read the
 * folder kept the file's name for good, so README.md's chip read "Friday Studio" live and "README" after a reload, and a chip
 * never matched the rail's title (Arun, 2026-10-28: "iron everything and ensure we are good"). After a reload it reads what it
 * read before at once, then whatever the folder says now.
 */
const TITLES_KEY = "friday.work.titles";
/** Session id, then path, then title. */
let titles: Record<string, Record<string, string>> = (() => {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(TITLES_KEY) ?? "{}");
    return kept && typeof kept === "object" ? kept : {};
  } catch {
    return {};
  }
})();
let titlesVersion = 0;
const titleListeners = new Set<() => void>();
/** The session the page is showing, whose titles the chips read. */
const titleScope = () => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("session") ?? "";
  } catch {
    return "";
  }
};
export function learnTitles(files: Pick<WorkFile, "path" | "title">[], scope = titleScope()): void {
  const had = titles[scope] ?? {};
  const now: Record<string, string> = {};
  for (const f of files) if (f.title) now[f.path] = pieceTitle(f);
  const keys = Object.keys(now);
  if (keys.length === Object.keys(had).length && keys.every((k) => had[k] === now[k])) return;
  // The newest twenty sessions' are kept: the oldest go first.
  const rest = Object.entries(titles).filter(([k]) => k !== scope).slice(-19);
  titles = { ...Object.fromEntries(rest), [scope]: now };
  titlesVersion++;
  try {
    globalThis.localStorage?.setItem(TITLES_KEY, JSON.stringify(titles));
  } catch {
    // Storage full or off: the chips still read them for as long as the page is open.
  }
  for (const l of titleListeners) l();
}
export const chipTitle = (path: string, scope = titleScope()): string => {
  const p = path.replace(/^\.\//, "");
  for (const [k, t] of Object.entries(titles[scope] ?? {})) if (k === p || k.endsWith(`/${p}`) || p.endsWith(`/${k}`)) return t;
  // A file that is no piece of writing, page, sheet or media (ci.yml, model.yaml) keeps its own name: made into words it was an
  // invented title, "Ci" or "Model" (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY VISUAL").
  return PIECE_EXT.test(p) ? fileTitle(p) : name(p);
};
const PIECE_EXT = /\.(md|markdown|mdx|txt|rtf|html?|csv|tsv|pdf|docx?|pptx?|xlsx?|key|pages|numbers|png|jpe?g|gif|webp|avif|svg|heic|mp4|mov|webm|m4v|mp3|wav|m4a|aac|ogg|flac)$/i;
/**
 * A chip's words: the piece's title, except where the agent named the file by its own name ("README.md"), when that name is what
 * the chip says. A README titled "Notes" by its first heading read as a different file (verify report, 2026-10-28; Arun,
 * 2026-10-29: "Make everything is redesigned like panel contents, etc"). A path ("outputs/brief.md") still reads as its title.
 */
export const chipLabel = (text: string, path: string, scope = titleScope()): string => {
  const said = text.trim().replace(/^[`'"]+|[`'"]+$/g, "").replace(/^\.\//, "");
  const own = name(path.replace(/^\.\//, ""));
  return said && !said.includes("/") && said.toLowerCase() === own.toLowerCase() ? own : chipTitle(path, scope);
};
/** For a chip: drawn again when the titles it reads change. */
export const titlesChanged = (on: () => void) => (titleListeners.add(on), () => void titleListeners.delete(on));
export const titlesNow = () => titlesVersion;

const URGENT: Record<string, number> = { needs: 0, working: 1, review: 2, ready: 3, idle: 4 };

/**
 * The Work home's "Right now": one row a session, its most pressing agent's (waiting on you, then working, then the rest, the
 * latest first), said in plain words. A row an agent listed the same title twice, and a stopped one read out the coding tool's
 * own error, a terminal command and all (Arun, 2026-10-28: "iron everything and ensure we are good").
 */
export function workRightNow(cards: BoardCard[]): BoardCard[] {
  const best = new Map<string, BoardCard>();
  for (const c of cards) {
    const had = best.get(c.sid);
    if (!had || (URGENT[c.column] ?? 9) - (URGENT[had.column] ?? 9) < 0 || ((URGENT[c.column] ?? 9) === (URGENT[had.column] ?? 9) && c.at > had.at)) best.set(c.sid, c);
  }
  return [...best.values()].map((c) => {
    if (c.column !== "needs") return c;
    const plain =
      c.status === "Stopped"
        ? limitHit(c.detail)
          ? "Out of usage"
          : signedOut(c.detail)
            ? "Isn't signed in on this computer"
            : "Stopped on an error"
        : c.status === "Wants to run a command"
          ? "Asks you before it goes on"
          : c.detail;
    // The reason, not the task: what to open it for.
    return { ...c, task: "", detail: plain || c.status };
  });
}
