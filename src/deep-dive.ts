import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { EngineTool } from "./types.js";

/**
 * Deep Dive: a repo explained, page by page, with every claim pointing at the lines it is about, and questions about the code
 * answered the same way (Arun, 2026-11-11, after what Devin has that Friday doesn't: "Repo wiki and Q&A: docs, diagrams and
 * answers about a codebase … Deep Dive is what we should call it"). The plan is Friday Work HQ/product/specs/06-repo-wiki.md.
 *
 * Written by the person's own coding tool on the computer the repo is on, in plan mode, so it reads and changes nothing and
 * costs nothing beyond their own plan; the code never leaves that computer, only the pages do. The steps:
 *
 * 1. A survey with no model (runner/dive.ts): every file, each folder's size and how often it changes, the commit, the repo's
 *    own README and agent notes.
 * 2. An outline, one turn: an overview first, a page per part of the system, a glossary last, each with the files it covers.
 * 3. The pages, a few at a time, each citing `path:start-end` for what it says about the code.
 * 4. Checked with no model: every citation's file is there and its lines are inside the file; every diagram is one the page can
 *    draw. A page that fails is asked once more with what failed; what still fails is struck through and said, never kept as
 *    if it were true. That is the complaint people have about DeepWiki: wrong details, stated confidently.
 * 5. What no page covers is listed as not covered yet, rather than the outline silently skipping a part of the repo.
 *
 * Kept per repo key (repo-key.ts), as the project brain is, inside Friday rather than in the repo (Arun's call, 2026-11-11).
 */

export interface DiveFolder {
  path: string;
  files: number;
  lines: number;
  changes: number;
}
/** What runner/dive.ts surveyRepo answers, as it crosses to the server. */
export interface DiveSurvey {
  files: string[];
  more: boolean;
  folders: DiveFolder[];
  lines: number;
  head: string;
  branch: string;
  remote: { url: string; github: string | null };
  docs: { name: string; text: string }[];
}

export interface DivePlan {
  id: string;
  title: string;
  purpose: string;
  files: string[];
}
export interface DivePage extends DivePlan {
  status: "waiting" | "writing" | "done" | "failed";
  body: string;
  /** Citations that still didn't match the code after the second try: struck through in the page, and said under it. */
  bad: string[];
  /** Diagrams that couldn't be drawn, left as their text. */
  badDiagrams: number;
  at: number;
  error?: string;
}
export interface DiveAsk {
  id: string;
  question: string;
  answer: string;
  bad: string[];
  by: string;
  at: number;
  status: "asking" | "done" | "failed";
  error?: string;
  /** The model picked to answer it, when not the Deep Dive's small one (Arun, 2026-11-12: "be able to swap models ... for asking"). */
  model?: string;
}
export interface Dive {
  key: string;
  name: string;
  /** Where the repo is on the computer that wrote it. */
  folder: string;
  tool: EngineTool;
  model?: string;
  /** The model it was written on, as said on the page: the tool's cheap default (DIVE_MODELS) or the one picked. */
  writer?: string;
  by: string;
  status: "building" | "ready" | "failed";
  stage?: "survey" | "outline" | "pages";
  head: string;
  branch: string;
  files: number;
  lines: number;
  started: number;
  at: number;
  done: number;
  total: number;
  uncovered: { path: string; files: number; lines: number }[];
  error?: string;
}

// ── the outline ─────────────────────────────────────────────────────

/** How many pages a repo gets, by how much code it has: a small one doesn't need thirty, a big one can't be told in six. */
/** How many pages: fewer than it was, each wider, so a big repo is written in minutes, not most of an hour (Arun, 2026-11-12: "taking forever"). */
export const pagesFor = (lines: number) => (lines < 3_000 ? 5 : lines < 20_000 ? 8 : lines < 80_000 ? 11 : lines < 200_000 ? 14 : 18);

export const DIVE_SYSTEM =
  "You are writing Deep Dive, the pages that explain a code repository to the people and coding agents who work on it. You only read: never change, create or delete a file, and never run anything that would. Say only what the code shows; where you aren't sure, say so.";

const listFolders = (s: DiveSurvey) =>
  s.folders
    .filter((f) => f.files)
    .map((f) => `${f.path} — ${f.files} files, ${f.lines} lines, changed in ${f.changes} commits lately`)
    .join("\n");

export function outlinePrompt(s: DiveSurvey, name: string): string {
  const n = pagesFor(s.lines);
  const files = s.files.slice(0, 1500).join("\n");
  const docs = s.docs.map((d) => `--- ${d.name} (its start) ---\n${d.text}`).join("\n\n");
  return [
    `Plan the Deep Dive for ${name}: about ${n} pages that together explain how this repository is put together and how it works.`,
    "Plan from what is below. Open a file only where a part's purpose really isn't clear from its names and notes, and then only a few: the pages themselves read the code.",
    "",
    `Its folders (${s.lines} lines of code in all):`,
    listFolders(s),
    "",
    docs ? `Its own notes:\n${docs}\n` : "",
    `Its files${s.more ? " (the first part of the list)" : ""}:`,
    files,
    "",
    "Answer with only a JSON array, no other words. Each item is one page:",
    '{"id": "short-kebab-id", "title": "A short name", "purpose": "One sentence: what a reader learns here", "files": ["path/one.ts", "path/two.ts"]}',
    'Titles are names of 1 to 4 words, as a book\'s chapters are ("Session core", "The runner", "Storage"), never a sentence or a colon: the purpose says the rest.',
    "The first page is the overview (id \"overview\"): what this is, its main parts and how they fit. The last is the glossary (id \"glossary\"): the terms people meet in this code.",
    "Between them, one page per part of the system a person would want explained on its own. Every part of the repo that matters belongs to some page.",
    "Give each page the 3 to 12 files it is mostly about, as paths from the repo's root exactly as listed above.",
  ].join("\n");
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
export const slash = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** The outline from the model's answer, kept to files that are really in the repo; null when there's no outline in it. */
export function parseOutline(text: string, s: DiveSurvey): DivePlan[] | null {
  const from = text.indexOf("[");
  const to = text.lastIndexOf("]");
  if (from < 0 || to <= from) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const known = new Set(s.files);
  const seen = new Set<string>();
  const pages: DivePlan[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 80) : "";
    if (!title) continue;
    let id = slug(typeof o.id === "string" && o.id ? o.id : title) || "page";
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    const files = (Array.isArray(o.files) ? o.files : []).filter((f): f is string => typeof f === "string").map(slash).filter((f) => known.has(f));
    pages.push({ id, title, purpose: typeof o.purpose === "string" ? o.purpose.trim().slice(0, 300) : "", files: [...new Set(files)].slice(0, 12) });
  }
  if (!pages.length) return null;
  return bookends(pages.slice(0, 30), s);
}

/** Overview first and glossary last, whatever order the answer gave, and both there. */
function bookends(pages: DivePlan[], s: DiveSurvey): DivePlan[] {
  const overview = pages.find((p) => p.id === "overview") ?? { id: "overview", title: "Overview", purpose: "What this repo is, its main parts and how they fit together.", files: s.docs.map((d) => d.name).filter((n) => s.files.includes(n)) };
  const glossary = pages.find((p) => p.id === "glossary") ?? { id: "glossary", title: "Glossary", purpose: "The terms people meet in this code, each in a line.", files: [] };
  return [overview, ...pages.filter((p) => p !== overview && p !== glossary), glossary];
}

/** When the model gave no outline Friday can read: a page for each of the biggest folders, which is still a useful start. */
export function fallbackOutline(s: DiveSurvey): DivePlan[] {
  const n = pagesFor(s.lines) - 2;
  const big = s.folders.filter((f) => f.lines > 0 && f.path !== ".").sort((a, b) => b.lines - a.lines).slice(0, n);
  const pages = big.map((f) => ({ id: slug(f.path) || "root", title: f.path, purpose: `What ${f.path} does and how.`, files: s.files.filter((x) => x.startsWith(`${f.path}/`)).slice(0, 12) }));
  return bookends(pages, s);
}

// ── a page ──────────────────────────────────────────────────────────

const RULES = [
  "Write it in Markdown, for someone new to this code: plain words, short paragraphs.",
  "Start with a paragraph saying what this part is for. Then use ## sections. Don't add a title heading: Friday shows the page's title.",
  "Cite every claim about the code as `path:start-end` in backticks (for example `src/server.ts:40-62`): paths from the repo's root with forward slashes, line numbers as the files are now. A claim you can't point at doesn't go in.",
  "Use a diagram where it helps, at most two: a ```mermaid block, flowchart or sequenceDiagram, with short labels in double quotes.",
  "End each ## section with one line that begins `Sources:` and lists the citations the section rests on, most important first.",
  "Your last message is the page itself and nothing else: no preamble, no note about what you did.",
];

export function pagePrompt(page: DivePlan, plan: DivePlan[], name: string, sources: { file: string; text: string; total: number; cut: boolean }[] = []): string {
  const others = plan
    .filter((p) => p.id !== page.id)
    .map((p) => `- ${p.title}: ${p.purpose}`)
    .join("\n");
  const what =
    page.id === "overview"
      ? "The big picture: what this repository is, its main parts, and how one typical thing (a request, a command, a job) moves through them. Include one diagram of the main parts."
      : page.id === "glossary"
        ? "The terms people meet in this code (its own names for things), one line each, alphabetical, each with a citation where the term is defined or mostly used."
        : page.purpose;
  return [
    `Write the Deep Dive page "${page.title}" for ${name}.`,
    `What it covers: ${what}`,
    sources.length
      ? `Its files are below, each line numbered: cite those numbers. Write from them; open another file only when the page can't be right without it.\n\n${sources.map((x) => `--- ${x.file} (${x.total} lines${x.cut ? ", cut here: read on if the page needs the rest" : ""}) ---\n${x.text}`).join("\n")}`
      : page.files.length
        ? `Start from these files, then read whatever they lead to:\n${page.files.map((f) => `- ${f}`).join("\n")}`
        : "Find the files it needs yourself.",
    "",
    `The other pages (don't repeat what belongs to them; a reader can go there):\n${others}`,
    "",
    ...RULES,
  ].join("\n");
}

export function retryPrompt(page: DivePlan, bad: string[], badDiagrams: number): string {
  return [
    `Some of your page "${page.title}" doesn't match the code.`,
    bad.length ? `These citations point at a file that isn't there or at lines past its end:\n${bad.map((b) => `- ${b}`).join("\n")}` : "",
    badDiagrams ? `${badDiagrams} of its diagrams can't be drawn: check each starts with flowchart or sequenceDiagram and that brackets and quotes are closed.` : "",
    "Check those against the files and send the whole page again, corrected. A claim you can't point at, leave out.",
    "",
    ...RULES,
  ]
    .filter(Boolean)
    .join("\n");
}

export function askPrompt(question: string, plan: DivePlan[], overview: string, name: string): string {
  return [
    `Someone working on ${name} asks: ${question}`,
    "",
    plan.length ? `Deep Dive's pages for this repo, to see where to look first:\n${plan.map((p) => `- ${p.title}: ${p.purpose}${p.files.length ? ` (${p.files.slice(0, 6).join(", ")})` : ""}`).join("\n")}` : "",
    overview ? `\nIts overview:\n${overview.slice(0, 6000)}` : "",
    "",
    "Read the code you need and answer them directly, in plain words, as short as the answer allows.",
    "Cite every claim about the code as `path:start-end` in backticks (paths from the repo's root, forward slashes). Use a ```mermaid diagram only if it really helps.",
    "Your last message is the answer itself and nothing else.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

// ── checking ────────────────────────────────────────────────────────

export interface Citation {
  raw: string;
  file: string;
  start: number;
  end: number;
}

/** The text outside fenced blocks, so a citation-looking line inside a code sample isn't checked as one. */
const outsideFences = (md: string) => md.split(/(```[\s\S]*?(?:```|$))/g).filter((_, i) => i % 2 === 0);

const BARE_FILE = /^(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|md|json|ya?ml|toml|css|scss|html?|sql|sh|vue|svelte|ex|exs|dart|scala|lua|gradle|xml|ini|cfg|lock|txt))$/;
const CITE = /^(?!\/|[A-Za-z]:|~)([^\s:`'"<>|*?]+?):(\d+)(?:-(\d+))?$/;

/** Every `path:line` or `path:start-end` in backticks. A backslashed Windows path is read with forward slashes. */
export function citationsIn(md: string): Citation[] {
  const out: Citation[] = [];
  for (const part of outsideFences(md)) {
    for (const m of part.matchAll(/`([^`\n]+)`/g)) {
      const raw = m[1]!.trim();
      const c = CITE.exec(raw);
      if (!c) continue;
      const file = slash(c[1]!);
      // A file, not `host:8080` or `console.log:3`: it has a folder, or it is a name with a source file's extension or a known name.
      if (!file.includes("/") && !BARE_FILE.test(file)) continue;
      const start = Number(c[2]);
      out.push({ raw, file, start, end: c[3] ? Number(c[3]) : start });
    }
  }
  return out;
}

/** The citations that don't match the code: a file that isn't there, lines past its end, or a range backwards. */
export function badCitations(cites: Citation[], counts: Record<string, number | null>): string[] {
  const bad = cites.filter((c) => {
    const n = counts[c.file];
    return n === null || n === undefined || c.start < 1 || c.end < c.start || c.end > n;
  });
  return [...new Set(bad.map((c) => c.raw))];
}

/** A bad citation struck through and said, where it stood: the claim stays readable, and nobody takes it as checked. */
export function strikeBad(md: string, bad: string[]): string {
  if (!bad.length) return md;
  const set = new Set(bad);
  return md
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part, i) => (i % 2 ? part : part.replace(/`([^`\n]+)`/g, (whole, inner: string) => (set.has(inner.trim()) ? `~~${inner.trim().replace(/([_*~[\]])/g, "\\$1")}~~ *(not in the code)*` : whole))))
    .join("");
}

const DIAGRAM_TYPES = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\b/;

/** Whether a Mermaid diagram can be drawn, as far as can be told without drawing it: a known kind, brackets and quotes closed. */
export function mermaidOk(code: string): boolean {
  const lines = code.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
  if (!lines.length || !DIAGRAM_TYPES.test(lines[0]!)) return false;
  for (const line of lines) {
    if ((line.match(/"/g) ?? []).length % 2) return false;
    const bare = line.replace(/"[^"]*"/g, "");
    let depth = 0;
    for (const ch of bare) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      if (depth < 0) return false;
    }
    if (depth !== 0) return false;
  }
  return true;
}

/** How many of a page's diagrams can't be drawn. */
export const badDiagramsIn = (md: string) => [...md.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].filter((m) => !mermaidOk(m[1]!)).length;

/** A diagram that still can't be drawn is shown as its text, with a line saying so, rather than as an error box. */
export const unDraw = (md: string) => md.replace(/```mermaid\s*\n([\s\S]*?)```/g, (whole, code: string) => (mermaidOk(code) ? whole : `*A diagram Friday couldn't draw:*\n\n\`\`\`text\n${code}\`\`\``));

/** What the model wrote around the page, taken off: a fence round the whole of it, or a line of preamble before the first heading or paragraph. */
export function cleanPage(text: string): string {
  let t = text.trim();
  const whole = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (whole) t = whole[1]!.trim();
  // A title heading it was told not to add: the page shows its own.
  t = t.replace(/^#\s+[^\n]*\n+/, "");
  return t;
}

/** The folders with code that no page names a file in, biggest first: said as not covered yet. */
export function uncoveredFolders(s: DiveSurvey, plan: DivePlan[]): Dive["uncovered"] {
  const named = plan.flatMap((p) => p.files);
  return s.folders
    .filter((f) => f.path !== "." && f.lines >= 50)
    .filter((f) => !named.some((n) => n === f.path || n.startsWith(`${f.path}/`)))
    .filter((f) => {
      // A first-level folder whose second-level folders are all counted on their own has no files directly in it to cover.
      const deeper = s.folders.filter((g) => g.path.startsWith(`${f.path}/`));
      return !(f.path.split("/").length === 1 && deeper.length && deeper.reduce((n, g) => n + g.files, 0) >= f.files);
    })
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 20)
    .map((f) => ({ path: f.path, files: f.files, lines: f.lines }));
}

// ── building ────────────────────────────────────────────────────────

/** The computer the repo is on, asked one thing: runner/local-api.ts's ask, dive.survey and dive.lines. */
export type DiveHost = (method: string, params: Record<string, unknown>, ms: number) => Promise<unknown>;

const PAGE_MS = 10 * 60_000;
/** Pages written side by side: each is its own run of the tool, and a small model is quick to answer six. */
const AT_ONCE = 6;

/** Run `fn` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/** A page written, checked, written again once if it needs it, and kept with what still didn't hold. */
export async function writePage(host: DiveHost, d: Pick<Dive, "folder" | "tool" | "model">, page: DivePlan, plan: DivePlan[], name: string): Promise<Pick<DivePage, "body" | "bad" | "badDiagrams">> {
  const ask = async (prompt: string) => cleanPage((await askTool(host, d, prompt)).text);
  const check = async (body: string) => {
    const cites = citationsIn(body);
    const counts = cites.length ? ((await host("dive.lines", { path: d.folder, files: cites.map((c) => c.file) }, 60_000)) as { counts: Record<string, number | null> }).counts : {};
    return { bad: badCitations(cites, counts), badDiagrams: badDiagramsIn(body) };
  };
  // Its files read here and given with the question, so the tool writes rather than opens one file a turn at a time.
  const sources = page.files.length ? (((await host("dive.files", { path: d.folder, files: page.files }, 60_000).catch(() => null)) as { files?: Parameters<typeof pagePrompt>[3] } | null)?.files ?? []) : [];
  let body = await ask(pagePrompt(page, plan, name, sources));
  let found = await check(body);
  if (found.bad.length || found.badDiagrams) {
    const again = await ask(retryPrompt(page, found.bad, found.badDiagrams)).catch(() => "");
    if (again) {
      const second = await check(again);
      // The second try only when it is no worse: a model that "fixes" a page by dropping half of it isn't kept over the first.
      if (second.bad.length + second.badDiagrams <= found.bad.length + found.badDiagrams && again.length > body.length / 3) {
        body = again;
        found = second;
      }
    }
  }
  return { body: unDraw(strikeBad(body, found.bad)), bad: found.bad, badDiagrams: found.badDiagrams };
}

/**
 * Who writes a Deep Dive when nobody picked: each tool's own small, cheap model, since reading a repo and explaining it is
 * easy work done many times over (Arun, 2026-11-12: "make sure the deep dive stuff is written by a lower tier model like haiku
 * or … the equivalent for codex"). Claude Code's `haiku` is its alias for the newest Haiku; Codex names gpt-6-luna its "fast
 * and affordable model for easier tasks" (its model/list, 2026-11-12). A tool not named here runs its own default.
 */
export const DIVE_MODELS: Partial<Record<EngineTool, { id: string; name: string }>> = {
  claude: { id: "haiku", name: "Haiku" },
  codex: { id: "gpt-6-luna", name: "GPT-6-Luna" },
};
export const diveModel = (tool: EngineTool, picked?: string): string | undefined => picked || DIVE_MODELS[tool]?.id;

/**
 * One turn of the person's tool in the repo, on the Deep Dive's model. When that is the cheap default and the tool turns it
 * down (an older Codex without it, an account without it), the turn is asked again on the tool's own default, so a missing
 * small model never costs the Deep Dive.
 */
async function askTool(host: DiveHost, d: Pick<Dive, "folder" | "tool" | "model">, prompt: string): Promise<{ text: string }> {
  const go = (model?: string) => host("ask", { tool: d.tool, system: DIVE_SYSTEM, prompt, cwd: d.folder, timeoutMs: PAGE_MS, ...(model ? { model } : {}) }, PAGE_MS + 30_000) as Promise<{ text: string }>;
  const model = diveModel(d.tool, d.model);
  if (!model || d.model) return go(model);
  try {
    const r = await go(model);
    if (r.text.trim()) return r;
  } catch (e) {
    if (!/model|not (?:found|supported|available)|unknown|invalid|access/i.test((e as Error).message)) throw e;
  }
  return go();
}

/**
 * A whole Deep Dive, from the survey to the last page, saved as it goes so the page shows it filling in. A failed page is said
 * on its row and the rest carry on; a failed survey or outline fails the build, with why.
 */
/** Said when a Deep Dive is deleted, or written again, while this build of it is still going: the build stops, saving nothing. */
class Gone extends Error {}

export async function buildDive(store: DeepDives, host: DiveHost, d: Dive): Promise<void> {
  // Still the Deep Dive this build is for: not deleted, and not started again since (Arun, 2026-11-12: "be able to delete").
  let first = true;
  const live = async () => {
    if (first) return true;
    if ((await store.get(d.key))?.started !== d.started) throw new Gone();
    return true;
  };
  const save = async (patch: Partial<Dive>) => {
    await live();
    first = false;
    await store.saveMeta((d = { ...d, ...patch, at: Date.now() }));
  };
  const savePage = async (p: DivePage) => (await live()) && store.savePage(d.key, p);
  try {
    await save({ status: "building", stage: "survey", done: 0, total: 0 });
    const s = ((await host("dive.survey", { path: d.folder }, 120_000)) as { survey: DiveSurvey }).survey;
    await save({ stage: "outline", head: s.head, branch: s.branch, files: s.files.length, lines: s.lines });
    const outline = await askTool(host, d, outlinePrompt(s, d.name))
      .then((r) => parseOutline(r.text, s))
      .catch(() => null);
    const plan = outline ?? fallbackOutline(s);
    await live();
    await store.clearPages(d.key);
    for (const p of plan) await savePage({ ...p, status: "waiting", body: "", bad: [], badDiagrams: 0, at: Date.now() });
    await save({ stage: "pages", total: plan.length, uncovered: uncoveredFolders(s, plan) });
    let done = 0;
    await pool(plan, AT_ONCE, async (p) => {
      await savePage({ ...p, status: "writing", body: "", bad: [], badDiagrams: 0, at: Date.now() });
      try {
        const page = await writePage(host, d, p, plan, d.name);
        await savePage({ ...p, ...page, status: "done", at: Date.now() });
      } catch (e) {
        if (e instanceof Gone) throw e;
        await savePage({ ...p, status: "failed", body: "", bad: [], badDiagrams: 0, at: Date.now(), error: (e as Error).message.slice(0, 300) });
      }
      await save({ done: ++done });
    });
    const pages = await store.pages(d.key);
    const written = pages.filter((p) => p.status === "done").length;
    await save(written ? { status: "ready", stage: undefined } : { status: "failed", stage: undefined, error: pages.find((p) => p.error)?.error ?? "No page could be written." });
  } catch (e) {
    if (e instanceof Gone) return;
    await save({ status: "failed", stage: undefined, error: (e as Error).message.slice(0, 300) }).catch(() => {});
  }
}

/** A question answered by the person's tool in the repo, its citations checked as a page's are (struck through, not asked again). */
export async function answerAsk(store: DeepDives, host: DiveHost, d: Dive, ask: DiveAsk): Promise<void> {
  try {
    const pages = await store.pages(d.key);
    const overview = pages.find((p) => p.id === "overview")?.body ?? "";
    const r = await askTool(host, d, askPrompt(ask.question, pages, overview, d.name));
    const text = cleanPage(r.text);
    const cites = citationsIn(text);
    const counts = cites.length ? ((await host("dive.lines", { path: d.folder, files: cites.map((c) => c.file) }, 60_000)) as { counts: Record<string, number | null> }).counts : {};
    const bad = badCitations(cites, counts);
    await store.updateAsk(d.key, { ...ask, status: "done", answer: unDraw(strikeBad(text, bad)), bad, at: Date.now() });
  } catch (e) {
    await store.updateAsk(d.key, { ...ask, status: "failed", error: (e as Error).message.slice(0, 300), at: Date.now() });
  }
}

// ── where it is kept ────────────────────────────────────────────────

const ASKS_KEPT = 30;

/** One workspace's Deep Dives: one record per repo, a hash of its pages, and its recent questions. */
export class DeepDives {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}
  private get metaKey() {
    return `${this.prefix}dive`;
  }
  private pagesKey = (repo: string) => `${this.prefix}dive-pages:${repo}`;
  private asksKey = (repo: string) => `${this.prefix}dive-asks:${repo}`;

  async list(): Promise<Dive[]> {
    const all = await this.redis.hgetall(this.metaKey);
    return Object.values(all)
      .flatMap((raw) => {
        try {
          return [JSON.parse(raw) as Dive];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.at - a.at);
  }
  async get(repo: string): Promise<Dive | null> {
    const raw = await this.redis.hget(this.metaKey, repo);
    return raw ? (JSON.parse(raw) as Dive) : null;
  }
  async saveMeta(d: Dive): Promise<void> {
    await this.redis.hset(this.metaKey, d.key, JSON.stringify(d));
  }
  async pages(repo: string): Promise<DivePage[]> {
    const all = await this.redis.hgetall(this.pagesKey(repo));
    const order = (await this.redis.get(`${this.pagesKey(repo)}:order`))?.split(",") ?? [];
    return Object.values(all)
      .flatMap((raw) => {
        try {
          return [JSON.parse(raw) as DivePage];
        } catch {
          return [];
        }
      })
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }
  async savePage(repo: string, p: DivePage): Promise<void> {
    await this.redis.hset(this.pagesKey(repo), p.id, JSON.stringify(p));
    const order = (await this.redis.get(`${this.pagesKey(repo)}:order`))?.split(",").filter(Boolean) ?? [];
    if (!order.includes(p.id)) await this.redis.set(`${this.pagesKey(repo)}:order`, [...order, p.id].join(","));
  }
  async clearPages(repo: string): Promise<void> {
    await this.redis.del(this.pagesKey(repo), `${this.pagesKey(repo)}:order`);
  }
  async asks(repo: string): Promise<DiveAsk[]> {
    const raw = await this.redis.get(this.asksKey(repo));
    try {
      return raw ? (JSON.parse(raw) as DiveAsk[]) : [];
    } catch {
      return [];
    }
  }
  /** Newest first; an answer replaces its question's record. */
  async saveAsk(repo: string, a: DiveAsk): Promise<void> {
    const all = (await this.asks(repo)).filter((x) => x.id !== a.id);
    await this.redis.set(this.asksKey(repo), JSON.stringify([a, ...all].slice(0, ASKS_KEPT)));
  }
  /** An answer in its question's place, unless the question was deleted while it was being answered. */
  async updateAsk(repo: string, a: DiveAsk): Promise<boolean> {
    const all = await this.asks(repo);
    const i = all.findIndex((x) => x.id === a.id);
    if (i < 0) return false;
    all[i] = a;
    await this.redis.set(this.asksKey(repo), JSON.stringify(all));
    return true;
  }
  async removeAsk(repo: string, id: string): Promise<boolean> {
    const all = await this.asks(repo);
    const left = all.filter((x) => x.id !== id);
    if (left.length === all.length) return false;
    await this.redis.set(this.asksKey(repo), JSON.stringify(left));
    return true;
  }
  async clearAsks(repo: string): Promise<void> {
    await this.redis.del(this.asksKey(repo));
  }
  async remove(repo: string): Promise<void> {
    await this.redis.hdel(this.metaKey, repo);
    await this.redis.del(this.pagesKey(repo), `${this.pagesKey(repo)}:order`, this.asksKey(repo));
  }
}

export const newAskId = () => randomBytes(6).toString("hex");
