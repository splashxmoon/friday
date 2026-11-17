import type { CardPress } from "./types.js";

/**
 * Cards an agent draws in a session's chat (Arun, 2026-11-02: "can we look into generative UI components for the session chats",
 * "Build the four"), in Friday on this computer (gen-ui.ts; Arun's own build first, public since v0.3.1). The agent describes one, and Friday
 * draws it with its own parts (client/GenUI.tsx): nothing it sends is run, and every card looks like the rest of Friday. The
 * same idea as Google's A2UI, a catalog the app already has, rather than MCP Apps' HTML in a frame.
 *
 * choices: two to six options as buttons; the pick reaches the agent as a message from the person.
 * table:   columns and rows: test results, a comparison, files and what changed in each.
 * chart:   a few numbers worth seeing, as bars or a line.
 * compare: two things side by side, before and after: two screenshots, or two snippets of text or code.
 * form:    a few values the agent needs, filled in and sent back together.
 * sources: the pages the agent read, each with its site and why it matters.
 *
 * No plan or status card (Arun, 2026-11-02: "get rid of this", "and this"): agents struck through the blocked steps of a plan
 * and put words in status tiles. Old ones in a session's log are drawn as nothing.
 *
 * And five more, interactive (Arun, 2026-11-17: "very advanced and beautiful generative UI in the chats... dynamic and
 * interactive", "GO ALL OUT"; research in Friday Work HQ product/research/generative-ui.md, after Google's A2UI):
 * pictures: two to four options shown as pictures (screenshots the agent took); one pick.
 * changes:  the files an edit touched, each unfolding to what changed in it (Friday reads the diff itself), then Looks good or
 *           Ask for changes, or Undo one file.
 * run:      a test run or build as numbers that move and failures as they land: updated by the agent (update_ui), or by Friday
 *           from the command's own output once it finishes.
 * select:   rows to tick, sorted by a column, and a button that counts them ("Fix 3").
 * goahead:  before anything outward: exactly what will run, with the person's settings filled into the commands, checked as they
 *           type; Hold or Approve. It asks; it never runs anything itself.
 * Every press goes back to the agent as one message, its plain words and the values (`card` on the instruction); with `wait`, as
 * the answer to the very call that drew the card, so the agent carries on in the same turn.
 *
 * And seven for every kind of work, not only code (Arun, 2026-11-17: "ADD BETTER GENERATIVE UI DESIGNS... AND ADD MORE", "THINK OF
 * ALL USE CASES NOT JUST FOR CODING"): research, writing, marketing, planning, ops.
 * stats:    a few numbers worth a glance, each with how it moved and a small line of its history (sign-ups, cost, speed).
 * draft:    something written for somewhere (an email, a post on X or LinkedIn, a chat message, a doc): shown as it will read there,
 *           edited in place, then Looks good or Ask for changes. Nothing is sent from the card.
 * slots:    times to pick from, by day: a call, a post, a launch.
 * matrix:   two to four options weighed side by side, criterion by criterion, each cell good, fair or poor; one picked.
 * links:    a few pages, documents, pull requests or videos, each a card with what it is and where.
 * file:     a few lines of a file, numbered, the ones that matter marked: code, a config, a contract clause.
 * timeline: what happened, or what will, in order: a launch week, an incident, a deploy.
 */

export type UiKind = "choices" | "table" | "chart" | "compare" | "form" | "sources" | "pictures" | "changes" | "run" | "select" | "goahead" | "stats" | "draft" | "slots" | "matrix" | "links" | "file" | "timeline";
/** A tone a card may give a thing: never a colour of the agent's choosing. */
export type Tone = "good" | "warn" | "bad" | "neutral";
export interface StatTile {
  label: string;
  value: string;
  /** How it moved: "+12%", "−0.4s". */
  delta?: string;
  /** Which way is better, for the delta's tone. */
  better?: "up" | "down";
  note?: string;
  /** A small line of its history, oldest first. */
  spark?: number[];
}
export interface LinkItem {
  title: string;
  url: string;
  kind?: "page" | "doc" | "pr" | "issue" | "video" | "repo" | "file";
  /** A word on where it stands: "Open", "Merged", "Draft", "12 min". */
  meta?: string;
  note?: string;
}
export interface TimelineEvent {
  when: string;
  title: string;
  detail?: string;
  tone?: Tone;
  tag?: string;
}
export interface MatrixRow {
  label: string;
  cells: { text: string; tone?: Tone }[];
}
/** A button at a card's foot: its name goes back to the agent with what was pressed; `input` asks for a line with it. */
export interface UiAction {
  name: string;
  label: string;
  primary?: boolean;
  /** Asks for a line before it goes: its placeholder ("What should change?"). */
  input?: string;
}
/** One file an edit touched, as the session's own git says (gen-ui.ts fills it in). */
export interface ChangedFile {
  path: string;
  status: "new" | "deleted" | "changed";
  added: number;
  removed: number;
  /** Its hunks, unified, trimmed to a size the chat can hold. */
  diff?: string;
}
export interface RunFailure {
  name: string;
  /** The line that says why. */
  detail?: string;
  /** Where: a file and line. */
  where?: string;
}
export interface SelectRow {
  id: string;
  cells: string[];
  checked?: boolean;
  /** A strip of small bars: 0 a quiet one, more a marked one (a test failing that day). */
  trend?: number[];
}
/** What a press on a card sent the agent (instruction.card): the card, the button and what was filled in. */
export type CardAnswer = CardPress;
export interface CompareSide {
  label: string;
  /** A picture on this computer (a screenshot), by its path. */
  image?: string;
  text?: string;
}
export interface FormField {
  id: string;
  label: string;
  type: "text" | "number" | "select" | "toggle";
  options?: string[];
  placeholder?: string;
  /** What it starts as. */
  value?: string;
  /** Checks run as the person types; the button stays off until they pass. */
  required?: boolean;
  /** A pattern the value must match (a regular expression). */
  pattern?: string;
  /** What to say when it doesn't pass ("A full version, like v2.14.0"). */
  hint?: string;
  min?: number;
  max?: number;
}

export interface UiCard {
  kind: UiKind;
  title: string;
  /** A line under the title. */
  note?: string;
  options?: { label: string; detail?: string; image?: string }[];
  /** The option the agent would pick, by its label. */
  recommended?: string;
  columns?: string[];
  rows?: string[][];
  chart?: "bar" | "line";
  labels?: string[];
  series?: { name: string; values: number[] }[];
  /** What the chart's numbers are in: "ms", "KB", "%". */
  unit?: string;
  left?: CompareSide;
  right?: CompareSide;
  /** compare: the texts are code, in a fixed-width face. */
  code?: boolean;
  fields?: FormField[];
  /** form: its button's words. */
  submit?: string;
  /** sources, links: the pages. */
  links?: LinkItem[];
  /** The buttons at its foot (changes, run, select). */
  actions?: UiAction[];
  /** The call that drew it waits for the press, which comes back as its answer. */
  wait?: boolean;
  /** changes: the files. */
  files?: ChangedFile[];
  /** run: what runs (goahead: the commands, below). */
  command?: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  failures?: RunFailure[];
  /** run: it has finished. */
  done?: boolean;
  /** run: when it started, for its clock (Friday sets it). */
  startedAt?: number;
  /** select: the rows. */
  items?: SelectRow[];
  /** select: the heading over the trend strips. */
  trendLabel?: string;
  /** goahead: what will run, the fields' values put in where a command says {field}. */
  commands?: string[];
  /** goahead: its Approve button's words. */
  approve?: string;
  /** stats: the tiles. */
  tiles?: StatTile[];
  /** draft: where it goes. */
  channel?: "email" | "x" | "linkedin" | "chat" | "post" | "doc" | "sms";
  /** draft: to whom, and its subject (an email). */
  to?: string;
  subject?: string;
  /** draft, file: the text itself. */
  body?: string;
  /** draft: the most characters it may have (a post on X: 280). */
  limit?: number;
  /** slots: the times, by day. */
  days?: { label: string; times: string[] }[];
  /** slots: the time zone they're in, and how long. */
  zone?: string;
  length?: string;
  /** matrix: the options weighed (columns) and the criteria (rows). */
  choices?: string[];
  criteria?: MatrixRow[];
  /** file: its path, what it's written in, the first line's number, and the lines that matter. */
  path?: string;
  language?: string;
  start?: number;
  marked?: number[];
  /** timeline: the events, in order. */
  events?: TimelineEvent[];
}

const KINDS: readonly UiKind[] = ["choices", "table", "chart", "compare", "form", "sources", "pictures", "changes", "run", "select", "goahead", "stats", "draft", "slots", "matrix", "links", "file", "timeline"];
/** The kinds a person answers: their call may wait for it. */
export const ANSWERED: readonly UiKind[] = ["choices", "form", "pictures", "changes", "run", "select", "goahead", "draft", "slots", "matrix"];
const TONES: readonly Tone[] = ["good", "warn", "bad", "neutral"];
const tone = (v: unknown): Tone | undefined => TONES.find((t) => t === v);
const num = (v: unknown, lo = 0, hi = 1e9): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : undefined);
/** A pattern a field may check against: short, and one that compiles. */
const safePattern = (v: unknown): string => {
  const p = typeof v === "string" ? v.trim().slice(0, 120) : "";
  if (!p) return "";
  try {
    new RegExp(p);
    return p;
  } catch {
    return "";
  }
};
function cleanActions(v: unknown): UiAction[] {
  const seen = new Set<string>();
  return list(v, 3).flatMap((a): UiAction[] => {
    if (!a || typeof a !== "object") return [];
    const o = a as Record<string, unknown>;
    const label = text(o.label, 30);
    const name = (text(o.name, 30).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 30);
    if (!label || !name || seen.has(name)) return [];
    seen.add(name);
    const input = text(o.input, 80);
    return [{ name, label, ...(o.primary === true ? { primary: true } : {}), ...(input ? { input } : {}) }];
  });
}
function cleanFields(v: unknown, n: number): FormField[] {
  const seen = new Set<string>();
  return list(v, n).flatMap((f): FormField[] => {
    if (!f || typeof f !== "object") return [];
    const o = f as Record<string, unknown>;
    const label = text(o.label, 60);
    const id = text(o.id, 30).replace(/[^\w-]/g, "") || label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    if (!label || !id || seen.has(id)) return [];
    seen.add(id);
    const type = o.type === "number" || o.type === "select" || o.type === "toggle" ? o.type : "text";
    const options = type === "select" ? list(o.options, 12).map((x) => text(x, 60)).filter(Boolean) : [];
    if (type === "select" && options.length < 2) return [];
    const value = text(o.value, 200);
    const placeholder = text(o.placeholder, 80);
    const pattern = type === "text" ? safePattern(o.pattern) : "";
    const hint = text(o.hint, 120);
    const min = type === "number" ? num(o.min, -1e9) : undefined;
    const max = type === "number" ? num(o.max, -1e9) : undefined;
    return [{ id, label, type, ...(options.length ? { options } : {}), ...(placeholder ? { placeholder } : {}), ...(value ? { value } : {}), ...(o.required === true && type !== "toggle" ? { required: true } : {}), ...(pattern ? { pattern } : {}), ...(hint ? { hint } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }];
  });
}
/** A path inside the session's folder, as the agent named it: relative or absolute, never up and out. */
const filePath = (v: unknown) => ((p) => (p && !p.split(/[\\/]/).includes("..") && !/[\x00-\x1f]/.test(p) ? p : ""))(typeof v === "string" ? v.trim().slice(0, 300) : "");
/** Where a picture may be: a path on this computer, never a web address (the session serves it, client/LiveBlock.tsx). */
const picture = (v: unknown) => ((p) => (p && !/^[a-z]+:\/\//i.test(p) && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(p) ? p : ""))(typeof v === "string" ? v.trim().slice(0, 600) : "");
/** A block of text or code, its lines kept. */
const block = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").slice(0, n).replace(/\s+$/, "") : "");
const text = (v: unknown, n: number) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, n) : "");
const list = (v: unknown, n: number): unknown[] => (Array.isArray(v) ? v.slice(0, n) : []);

/** What a show_ui call asked for, made safe and small, or why it can't be drawn. */
export function cleanCard(args: Record<string, unknown>): { card: UiCard } | { error: string } {
  const kind = KINDS.find((k) => k === args.kind);
  if (!kind) return { error: `kind is one of ${KINDS.join(", ")}.` };
  const title = text(args.title, 120);
  if (!title) return { error: "Give the card a title: what it is about, in a few words." };
  const note = text(args.note, 300);
  const card: UiCard = { kind, title, ...(note ? { note } : {}) };
  if (kind === "choices") {
    const options = list(args.options, 6)
      .map((o) => (typeof o === "string" ? { label: text(o, 80) } : o && typeof o === "object" ? { label: text((o as Record<string, unknown>).label, 80), detail: text((o as Record<string, unknown>).detail, 200) } : { label: "" }))
      .filter((o) => o.label)
      .map((o) => (o.detail ? o : { label: o.label }));
    if (options.length < 2) return { error: "choices needs two to six options, each with a label." };
    if (new Set(options.map((o) => o.label.toLowerCase())).size < options.length) return { error: "Each option needs a label of its own." };
    const recommended = text(args.recommended, 80);
    return { card: { ...card, options, ...(recommended && options.some((o) => o.label === recommended) ? { recommended } : {}), ...(args.wait === true ? { wait: true } : {}) } };
  }
  if (kind === "table") {
    const columns = list(args.columns, 8).map((c) => text(c, 40));
    if (!columns.length || columns.some((c) => !c)) return { error: "table needs columns: up to eight headings." };
    const rows = list(args.rows, 30).map((r) => columns.map((_, i) => text(list(r, columns.length)[i], 160)));
    if (!rows.length) return { error: "table needs rows: each a list of cells, one per column." };
    return { card: { ...card, columns, rows } };
  }
  if (kind === "compare") {
    const side = (v: unknown): CompareSide | null => {
      if (!v || typeof v !== "object") return null;
      const o = v as Record<string, unknown>;
      const image = picture(o.image);
      const body = block(o.text, 4000);
      return image || body ? { label: text(o.label, 40), ...(image ? { image } : {}), ...(body ? { text: body } : {}) } : null;
    };
    const left = side(args.left);
    const right = side(args.right);
    if (!left || !right) return { error: "compare needs left and right, each with a label and an image (a path to a picture on this computer) or text." };
    return { card: { ...card, left: { ...left, label: left.label || "Before" }, right: { ...right, label: right.label || "After" }, ...(args.code === true ? { code: true } : {}) } };
  }
  if (kind === "form") {
    const fields = cleanFields(args.fields, 8);
    if (!fields.length) return { error: "form needs fields, each with a label and a type (text, number, select with options, or toggle)." };
    const submit = text(args.submit, 30);
    return { card: { ...card, fields, ...(submit ? { submit } : {}), ...(args.wait === true ? { wait: true } : {}) } };
  }
  if (kind === "sources") {
    const links = list(args.links, 10).flatMap((x) => {
      if (!x || typeof x !== "object") return [];
      const o = x as Record<string, unknown>;
      const url = text(o.url, 500);
      if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return [];
      const note = text(o.note, 200);
      return [{ title: text(o.title, 120) || url.replace(/^https?:\/\//, "").split("/")[0]!, url, ...(note ? { note } : {}) }];
    });
    if (!links.length) return { error: "sources needs links: each a title and an http(s) url, and a note on why it matters." };
    return { card: { ...card, links } };
  }
  const wait = ANSWERED.includes(kind) && args.wait === true ? { wait: true as const } : {};
  const actions = cleanActions(args.actions);
  if (kind === "pictures") {
    const options = list(args.options, 4).flatMap((o) => {
      if (!o || typeof o !== "object") return [];
      const r = o as Record<string, unknown>;
      const label = text(r.label, 60);
      const image = picture(r.image);
      const detail = text(r.detail, 140);
      return label && image ? [{ label, image, ...(detail ? { detail } : {}) }] : [];
    });
    if (options.length < 2) return { error: "pictures needs two to four options, each a label and an image: the absolute path of a picture on this computer (a screenshot you took)." };
    if (new Set(options.map((o) => o.label.toLowerCase())).size < options.length) return { error: "Each option needs a label of its own." };
    const recommended = text(args.recommended, 60);
    return { card: { ...card, options, ...(recommended && options.some((o) => o.label === recommended) ? { recommended } : {}), ...wait } };
  }
  if (kind === "changes") {
    const seen = new Set<string>();
    const files = list(args.files, 16).flatMap((f): ChangedFile[] => {
      const o = typeof f === "string" ? { path: f } : f && typeof f === "object" ? (f as Record<string, unknown>) : {};
      const path = filePath(o.path);
      if (!path || seen.has(path)) return [];
      seen.add(path);
      const status = o.status === "new" || o.status === "deleted" ? o.status : "changed";
      return [{ path, status, added: num(o.added) ?? 0, removed: num(o.removed) ?? 0, ...(typeof o.diff === "string" && o.diff.trim() ? { diff: block(o.diff, 6000) } : {}) }];
    });
    if (!files.length) return { error: "changes needs files: the paths you changed, as in the session's folder." };
    return { card: { ...card, files, actions: actions.length ? actions : [{ name: "revise", label: "Ask for changes", input: "What should change?" }, { name: "approve", label: "Looks good", primary: true }], ...wait } };
  }
  if (kind === "run") {
    const failures = list(args.failures, 20).flatMap((f): RunFailure[] => {
      const o = typeof f === "string" ? { name: f } : f && typeof f === "object" ? (f as Record<string, unknown>) : {};
      const name = text(o.name, 160);
      const detail = text(o.detail, 400);
      const where = text(o.where, 120);
      return name ? [{ name, ...(detail ? { detail } : {}), ...(where ? { where } : {}) }] : [];
    });
    const command = text(args.command, 200);
    const counts = Object.fromEntries((["total", "passed", "failed", "skipped"] as const).flatMap((k) => ((n) => (n === undefined ? [] : [[k, n]]))(num(args[k]))));
    const startedAt = num(args.startedAt, 0, 9e15);
    return { card: { ...card, ...(command ? { command } : {}), ...counts, ...(failures.length ? { failures } : {}), ...(args.done === true ? { done: true } : {}), ...(startedAt ? { startedAt } : {}), ...(actions.length ? { actions } : {}), ...wait } };
  }
  if (kind === "select") {
    const columns = list(args.columns, 6).map((c) => text(c, 32));
    if (!columns.length || columns.some((c) => !c)) return { error: "select needs columns: up to six headings, the first naming each row." };
    const ids = new Set<string>();
    const items = list(args.items ?? args.rows, 40).flatMap((r, i): SelectRow[] => {
      const o = Array.isArray(r) ? { cells: r } : r && typeof r === "object" ? (r as Record<string, unknown>) : {};
      const cells = columns.map((_, j) => text(list(o.cells, columns.length)[j], 120));
      if (!cells[0]) return [];
      let id = text(o.id, 40) || String(i + 1);
      while (ids.has(id)) id = `${id}-${i}`;
      ids.add(id);
      const trend = list(o.trend, 30).map((x) => num(x, 0, 9) ?? 0);
      return [{ id, cells, ...(o.checked === true ? { checked: true } : {}), ...(trend.length ? { trend } : {}) }];
    });
    if (!items.length) return { error: "select needs items: each its cells (one per column), an id, and checked: true for the ones you'd pick." };
    const trendLabel = text(args.trendLabel, 24);
    const submit = text(args.submit, 30);
    return { card: { ...card, columns, items, ...(trendLabel && items.some((x) => x.trend) ? { trendLabel } : {}), ...(submit ? { submit } : {}), ...(actions.length ? { actions } : {}), ...wait } };
  }
  if (kind === "stats") {
    const tiles = list(args.tiles, 6).flatMap((t): StatTile[] => {
      if (!t || typeof t !== "object") return [];
      const o = t as Record<string, unknown>;
      const label = text(o.label, 40);
      const value = text(o.value, 24);
      if (!label || !value) return [];
      const delta = text(o.delta, 16);
      const note = text(o.note, 80);
      const spark = list(o.spark, 30).map(Number).filter(Number.isFinite);
      return [{ label, value, ...(delta ? { delta } : {}), ...(o.better === "up" || o.better === "down" ? { better: o.better } : {}), ...(note ? { note } : {}), ...(spark.length >= 2 ? { spark } : {}) }];
    });
    if (!tiles.length) return { error: "stats needs tiles: each a label and a value, and how it moved if you know (delta, better: up or down)." };
    return { card: { ...card, tiles } };
  }
  if (kind === "draft") {
    const body = block(args.body, 6000);
    if (!body) return { error: "draft needs body: the text as it will read." };
    const channel = (["email", "x", "linkedin", "chat", "post", "doc", "sms"] as const).find((c) => c === args.channel) ?? "post";
    const to = text(args.to, 120);
    const subject = text(args.subject, 160);
    const limit = num(args.limit, 1, 100_000) ?? (channel === "x" ? 280 : undefined);
    return { card: { ...card, channel, body, ...(to ? { to } : {}), ...(subject ? { subject } : {}), ...(limit ? { limit } : {}), actions: actions.length ? actions : [{ name: "revise", label: "Ask for changes", input: "What should change?" }, { name: "approve", label: "Looks good", primary: true }], ...wait } };
  }
  if (kind === "slots") {
    const days = list(args.days, 7).flatMap((d) => {
      if (!d || typeof d !== "object") return [];
      const o = d as Record<string, unknown>;
      const label = text(o.label, 30);
      const times = list(o.times, 8).map((t) => text(t, 20)).filter(Boolean);
      return label && times.length ? [{ label, times }] : [];
    });
    if (!days.length) return { error: "slots needs days: each a label ('Wed 18 Nov') and times ('10:00', '14:30')." };
    const zone = text(args.zone, 40);
    const length = text(args.length, 20);
    return { card: { ...card, days, ...(zone ? { zone } : {}), ...(length ? { length } : {}), ...wait } };
  }
  if (kind === "matrix") {
    const choices = list(args.choices ?? args.columns, 4).map((c) => text(c, 40)).filter(Boolean);
    if (choices.length < 2) return { error: "matrix needs choices: two to four options to weigh." };
    const criteria = list(args.criteria, 10).flatMap((r): MatrixRow[] => {
      if (!r || typeof r !== "object") return [];
      const o = r as Record<string, unknown>;
      const label = text(o.label, 50);
      const cells = choices.map((_, i) => ((c) => (typeof c === "string" ? { text: text(c, 80) } : c && typeof c === "object" ? { text: text((c as Record<string, unknown>).text, 80), ...((t) => (t ? { tone: t } : {}))(tone((c as Record<string, unknown>).tone)) } : { text: "" }))(list(o.cells, choices.length)[i]));
      return label ? [{ label, cells }] : [];
    });
    if (!criteria.length) return { error: "matrix needs criteria: each a label and one cell per choice (text, and tone good, warn or bad)." };
    const recommended = text(args.recommended, 40);
    return { card: { ...card, choices, criteria, ...(recommended && choices.includes(recommended) ? { recommended } : {}), ...wait } };
  }
  if (kind === "links") {
    const links = list(args.links, 6).flatMap((x): LinkItem[] => {
      if (!x || typeof x !== "object") return [];
      const o = x as Record<string, unknown>;
      const url = text(o.url, 500);
      if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return [];
      const k = (["page", "doc", "pr", "issue", "video", "repo", "file"] as const).find((v) => v === o.kind);
      const meta = text(o.meta, 24);
      const note = text(o.note, 160);
      return [{ title: text(o.title, 120) || url.replace(/^https?:\/\//, "").split("/")[0]!, url, ...(k ? { kind: k } : {}), ...(meta ? { meta } : {}), ...(note ? { note } : {}) }];
    });
    if (!links.length) return { error: "links needs links: each a title and an http(s) url, and what it is (kind) and where it stands (meta)." };
    return { card: { ...card, links } };
  }
  if (kind === "file") {
    const body = block(args.body ?? args.content, 8000);
    if (!body) return { error: "file needs body: the lines to show." };
    const path = filePath(args.path);
    const language = text(args.language, 20);
    const start = num(args.start, 1, 1e7);
    const marked = list(args.marked, 60).map((n) => num(n, 1, 1e7)).filter((n): n is number => n !== undefined);
    return { card: { ...card, body, ...(path ? { path } : {}), ...(language ? { language } : {}), ...(start ? { start } : {}), ...(marked.length ? { marked } : {}) } };
  }
  if (kind === "timeline") {
    const events = list(args.events, 20).flatMap((e): TimelineEvent[] => {
      if (!e || typeof e !== "object") return [];
      const o = e as Record<string, unknown>;
      const when = text(o.when, 30);
      const title = text(o.title, 120);
      if (!when || !title) return [];
      const detail = text(o.detail, 240);
      const tag = text(o.tag, 20);
      const t = tone(o.tone);
      return [{ when, title, ...(detail ? { detail } : {}), ...(t ? { tone: t } : {}), ...(tag ? { tag } : {}) }];
    });
    if (!events.length) return { error: "timeline needs events: each a when and a title, in order." };
    return { card: { ...card, events } };
  }
  if (kind === "goahead") {
    const commands = list(args.commands, 6).map((c) => block(c, 300).replace(/\n+/g, " ")).filter(Boolean);
    if (!commands.length) return { error: "goahead needs commands: exactly what will run, with {field} where a field's value goes." };
    const fields = cleanFields(args.fields, 6);
    const approve = text(args.approve, 30);
    return { card: { ...card, commands, ...(fields.length ? { fields } : {}), ...(approve ? { approve } : {}), ...wait } };
  }
  const labels = list(args.labels, 24).map((l) => text(l, 24));
  if (labels.length < 2 || labels.some((l) => !l)) return { error: "chart needs labels: two to twenty-four, one per point." };
  const series = list(args.series, 4)
    .map((s) => (s && typeof s === "object" ? { name: text((s as Record<string, unknown>).name, 40), values: list((s as Record<string, unknown>).values, labels.length).map(Number) } : { name: "", values: [] as number[] }))
    .filter((s) => s.values.length === labels.length && s.values.every(Number.isFinite));
  if (!series.length) return { error: "chart needs series: each a name and one number per label." };
  const unit = text(args.unit, 12);
  return { card: { ...card, chart: args.chart === "line" ? "line" : "bar", labels, series: series.map((s, i) => ({ name: s.name || `Series ${i + 1}`, values: s.values })), ...(unit ? { unit } : {}) } };
}

/** What a pick on a choices card says to the agent, as the person's message: the card it answers, then the option. */
export const pickText = (title: string, label: string): string => `On “${title}”: ${label}`;

/** What a form sends the agent: the card it answers, then each field and what was put in it, a line each. */
export const formText = (title: string, fields: FormField[], values: Record<string, string>): string =>
  [`${pickText(title, "")}`.trimEnd(), ...fields.map((f) => `- ${f.label}: ${(values[f.id] ?? "").trim() || "(left empty)"}`)].join("\n");

/** A field's value against its checks: why it doesn't pass, or "" when it does. */
export function fieldProblem(f: FormField, v: string): string {
  const t = v.trim();
  if (f.type === "toggle" || f.type === "select") return "";
  if (!t) return f.required ? f.hint || "Needed" : "";
  if (f.type === "number") {
    const n = Number(t);
    if (!Number.isFinite(n)) return f.hint || "A number";
    if (f.min !== undefined && n < f.min) return f.hint || `At least ${f.min}`;
    if (f.max !== undefined && n > f.max) return f.hint || `At most ${f.max}`;
    return "";
  }
  if (f.pattern) {
    try {
      if (!new RegExp(`^(?:${f.pattern})$`).test(t.slice(0, 200))) return f.hint || "Not in the form it needs";
    } catch {
      return "";
    }
  }
  return "";
}

/** A goahead's commands with the fields' values put in where they say {field}. */
export const filled = (commands: string[], values: Record<string, string>): string[] => commands.map((c) => c.replace(/\{([\w-]+)\}/g, (m, k: string) => (k in values ? values[k]! : m)));

/**
 * What a press says to the agent, as the person's message: the card it answers and the button, then a line per value. The values
 * go with it too (instruction.card), for the agent to read exactly.
 */
export function answerText(card: UiCard, label: string, values: Record<string, string | string[]> = {}, extra: string[] = []): string {
  const lines = Object.entries(values)
    .filter(([k]) => k !== "note")
    .map(([k, v]) => `- ${card.fields?.find((f) => f.id === k)?.label ?? k}: ${Array.isArray(v) ? v.join(", ") : v || "(left empty)"}`);
  const note = typeof values.note === "string" && values.note.trim() ? `: ${values.note.trim()}` : "";
  return [pickText(card.title, `${label}${note}`), ...lines, ...extra].join("\n");
}


/**
 * What a test run's own output says: its counts and what failed, read from the runners people use (node's test runner, Jest,
 * Vitest, pytest, Go, Cargo, Mocha). Null when it says none of that.
 */
export function testCounts(out: string): { passed: number; failed: number; skipped: number; total: number; failures: RunFailure[] } | null {
  const s = out.replace(/\x1b\[[0-9;]*m/g, "");
  const n = (re: RegExp) => ((m) => (m ? Number(m[1]) : undefined))(re.exec(s));
  let passed: number | undefined;
  let failed: number | undefined;
  let skipped: number | undefined;
  let total: number | undefined;
  // node --test
  if (/^ℹ (tests|pass|fail) \d+/m.test(s)) {
    total = n(/^ℹ tests (\d+)/m);
    passed = n(/^ℹ pass (\d+)/m);
    failed = n(/^ℹ fail (\d+)/m);
    skipped = (n(/^ℹ skipped (\d+)/m) ?? 0) + (n(/^ℹ todo (\d+)/m) ?? 0);
  } else {
    // Jest ("Tests: 1 failed, 2 skipped, 10 passed, 13 total") and Vitest ("Tests  1 failed | 12 passed (13)").
    const line = /^\s*Tests:?\s+(.*\d.*)$/m.exec(s)?.[1];
    const said = line ?? /=+ (.*?(?:passed|failed).*?) in [\d.]+s/.exec(s)?.[1] ?? /test result: \w+\. (.*)$/m.exec(s)?.[1] ?? /^\s*(\d+ passing.*)$/m.exec(s)?.[1];
    if (said) {
      const get = (w: string) => ((m) => (m ? Number(m[1]) : undefined))(new RegExp(`(\\d+) ${w}`).exec(said));
      passed = get("passed") ?? get("passing");
      failed = (get("failed") ?? get("failing") ?? 0) + (get("errors?") ?? 0) || (get("failed") ?? get("failing"));
      skipped = get("skipped") ?? get("ignored") ?? get("pending") ?? get("todo");
      total = get("total") ?? ((m) => (m ? Number(m[1]) : undefined))(/\((\d+)\)\s*$/.exec(said));
    } else if (/^(--- (PASS|FAIL):|ok\s+\S+|FAIL\s+\S+)/m.test(s)) {
      passed = (s.match(/^--- PASS:/gm) ?? []).length;
      failed = (s.match(/^--- FAIL:/gm) ?? []).length;
    }
  }
  if (passed === undefined && failed === undefined) return null;
  const names = new Set<string>();
  const pull = (re: RegExp) => {
    for (const m of s.matchAll(re)) if (names.size < 12) names.add(m[1]!.trim().slice(0, 160));
  };
  pull(/^\s*✖ (?!failing tests)(.+?)(?: \(\d[\d.]*m?s\))?$/gm);
  pull(/^\s*● (.+?)$/gm);
  pull(/^FAILED (\S+?)(?: - .*)?$/gm);
  pull(/^--- FAIL: (\S+)/gm);
  pull(/^\s*[×✗] (.+?)(?: \d+m?s)?$/gm);
  pull(/^---- (\S+) stdout ----$/gm);
  const p = passed ?? 0;
  const f = failed ?? names.size;
  const k = skipped ?? 0;
  return { passed: p, failed: f, skipped: k, total: total ?? p + f + k, failures: [...names].map((name) => ({ name })) };
}

