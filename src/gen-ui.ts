import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MeshResult, MeshToolDef } from "./agent-mesh.js";
import { ANSWERED, cleanCard, pickText, type ChangedFile, type UiCard } from "./gen-ui-model.js";
import { laneName } from "./session/core.js";
import { pendingFor, runOf } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import { MAIN_LANE } from "./types.js";

/**
 * show_ui and update_ui, the friday server's tools for drawing a card in the chat (gen-ui-model.ts has the cards), in Friday on
 * this computer (the open-source edition and Arun's build; app.ts sets them on the mesh where it runs locally, not the hosted
 * service; public since v0.3.1). A card is a `ui.card` event on the agent's lane; shown again with its id (or changed with
 * update_ui), the latest is what is drawn, where the first one was.
 *
 * With `wait`, the call that drew a card the person answers waits for their press, up to four minutes, as ask_agent waits for an
 * answer, and returns it: the agent carries on in the same turn. The press is also the person's message on that lane; taken back
 * from the queue here, so the agent isn't handed it again as a turn of its own.
 */

const OPTION = { type: "object", properties: { label: { type: "string" }, detail: { type: "string", description: "A line on what picking it means." }, image: { type: "string", description: "pictures: the absolute path of a picture on this computer (a screenshot you took)." } }, required: ["label"], additionalProperties: false };
const SIDE = { type: "object", properties: { label: { type: "string", description: "Before, After, Option A…" }, image: { type: "string", description: "The absolute path of a picture on this computer: a screenshot you took." }, text: { type: "string", description: "Or a snippet of text or code." } }, required: ["label"], additionalProperties: false };
const FIELD = {
  type: "object",
  properties: {
    id: { type: "string", description: "goahead: the {id} its commands use." },
    label: { type: "string" },
    type: { type: "string", enum: ["text", "number", "select", "toggle"] },
    options: { type: "array", items: { type: "string" }, description: "select: its choices (two or three show as a switch of segments)." },
    placeholder: { type: "string" },
    value: { type: "string", description: "What it starts as." },
    required: { type: "boolean" },
    pattern: { type: "string", description: "text: a regular expression the whole value must match, checked as they type." },
    hint: { type: "string", description: "What to say when it doesn't pass: 'A full version, like v2.14.0'." },
    min: { type: "number" },
    max: { type: "number" },
  },
  required: ["label", "type"],
  additionalProperties: false,
};
const ACTION = { type: "object", properties: { name: { type: "string", description: "What comes back to you when it's pressed: approve, fix, take…" }, label: { type: "string", description: "Its words, short." }, primary: { type: "boolean", description: "The one most likely pressed." }, input: { type: "string", description: "Ask for a line with it: its placeholder ('What should change?')." } }, required: ["label"], additionalProperties: false };
const FAILURE = { type: "object", properties: { name: { type: "string", description: "The test or step that failed." }, detail: { type: "string", description: "The line that says why." }, where: { type: "string", description: "A file and line." } }, required: ["name"], additionalProperties: false };

export const GEN_UI_TOOL: MeshToolDef = {
  name: "show_ui",
  description: [
    "Draw a card in the chat for the person, in place of text that would be hard to read or a question that has a few concrete answers. Friday draws it with its own parts; you only describe it.",
    "choices: 2 to 6 options as rows to pick from. pictures: 2 to 4 options shown as pictures (absolute paths of screenshots you took), when they are easier to see than read: layouts, designs.",
    "changes: after you edit, the files you changed (just their paths: Friday reads the diff from the folder), each unfolding to what changed; the person says Looks good or Ask for changes (with a note), or undoes one file.",
    "run: a test run or build as live numbers: command, total, passed, failed, skipped, failures (name, detail, where); keep it current with update_ui as results come, and done: true at the end. Friday also fills it from the command's output when it finishes, if you name the command exactly.",
    "select: rows the person ticks (columns, items each with an id, cells, checked for the ones you'd pick, trend for a strip of small bars), with a button that counts them (submit, like 'Fix {n}').",
    "goahead: before anything outward (a deploy, a send, a migration): commands, exactly what will run, with {field} where a field's value goes, and fields with checks (required, pattern, min, max, hint). The person holds or approves; nothing runs until you do it after their yes.",
    "For any work, not only code: stats (a few numbers worth a glance: tiles, each a label, value, delta, better: up or down, and spark, a short history), draft (something written for somewhere, shown as it will read there: channel email, x, linkedin, chat, post, doc or sms, to, subject, body, limit; the person edits it in place and says Looks good or Ask for changes; send nothing yourself until they do), slots (times to pick: days, each a label and times; zone, length), matrix (two to four choices weighed criterion by criterion: criteria, each a label and one cell per choice with text and tone good, warn or bad; recommended), links (a few pages, docs, pull requests or videos as cards: title, url, kind, meta like Open or Merged, note), file (a few numbered lines of a file: path, body, start, marked lines that matter), timeline (what happened or will, in order: events, each when, title, detail, tone, tag).",
    "table, chart, compare, form, sources: as before (a table of results, a chart of a few numbers, two screenshots or snippets side by side, a few values to fill in, the pages you read).",
    "wait: true makes this call wait for the person's press and return it, so you carry on in this turn; without it, their press reaches you as a message. Say in a line what the card is for; don't repeat what it shows.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["choices", "pictures", "changes", "run", "select", "goahead", "stats", "draft", "slots", "matrix", "links", "file", "timeline", "table", "chart", "compare", "form", "sources"] },
      title: { type: "string", description: "What it is about, in a few words." },
      note: { type: "string", description: "A line under the title." },
      id: { type: "string", description: "To update a card you showed before: its id, from that call's answer." },
      wait: { type: "boolean", description: "Wait for the person's press and get it as this call's answer (choices, pictures, changes, run, select, goahead, draft, slots, matrix, form)." },
      actions: { type: "array", items: ACTION, description: "changes, run, select: up to three buttons at its foot (changes has Ask for changes and Looks good if left out)." },
      options: { type: "array", items: OPTION, description: "choices, pictures: the options." },
      recommended: { type: "string", description: "choices, pictures: the label of the one you'd pick." },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, description: "changes: the files you changed." },
      command: { type: "string", description: "run: what runs, exactly as you run it." },
      total: { type: "number" },
      passed: { type: "number" },
      failed: { type: "number" },
      skipped: { type: "number" },
      failures: { type: "array", items: FAILURE, description: "run: what failed so far." },
      done: { type: "boolean", description: "run: it has finished." },
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, cells: { type: "array", items: { type: "string" } }, checked: { type: "boolean" }, trend: { type: "array", items: { type: "number" } } }, required: ["cells"], additionalProperties: false }, description: "select: up to 40 rows." },
      trendLabel: { type: "string", description: "select: the heading over the trend strips ('14 days')." },
      commands: { type: "array", items: { type: "string" }, description: "goahead: exactly what will run." },
      approve: { type: "string", description: "goahead: its Approve button's words." },
      columns: { type: "array", items: { type: "string" }, description: "table: up to 8 headings; select: up to 6, the first naming each row." },
      rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "table: up to 30 rows, one cell per column." },
      chart: { type: "string", enum: ["bar", "line"] },
      labels: { type: "array", items: { type: "string" }, description: "chart: one per point, 2 to 24." },
      series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } }, required: ["name", "values"], additionalProperties: false }, description: "chart: up to 4, one number per label each." },
      unit: { type: "string", description: "chart: what the numbers are in (ms, KB, %)." },
      left: { ...SIDE, description: "compare: the first side." },
      right: { ...SIDE, description: "compare: the second side." },
      code: { type: "boolean", description: "compare: the texts are code." },
      fields: { type: "array", items: FIELD, description: "form, goahead: the fields." },
      submit: { type: "string", description: "form: its button's words (Send, if left out); select: its button's, with {n} for how many are ticked." },
      links: { type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" }, note: { type: "string" }, kind: { type: "string", enum: ["page", "doc", "pr", "issue", "video", "repo", "file"] }, meta: { type: "string", description: "links: where it stands, in a word or two." } }, required: ["title", "url"], additionalProperties: false }, description: "sources: up to 10; links: up to 6." },
      tiles: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, delta: { type: "string", description: "How it moved: +12%, −0.4s." }, better: { type: "string", enum: ["up", "down"] }, note: { type: "string" }, spark: { type: "array", items: { type: "number" }, description: "A short history, oldest first." } }, required: ["label", "value"], additionalProperties: false }, description: "stats: up to 6." },
      channel: { type: "string", enum: ["email", "x", "linkedin", "chat", "post", "doc", "sms"], description: "draft: where it goes." },
      to: { type: "string", description: "draft: to whom." },
      subject: { type: "string", description: "draft: an email's subject." },
      body: { type: "string", description: "draft: the text as it will read; file: the lines." },
      limit: { type: "number", description: "draft: the most characters (X is 280 if left out)." },
      days: { type: "array", items: { type: "object", properties: { label: { type: "string" }, times: { type: "array", items: { type: "string" } } }, required: ["label", "times"], additionalProperties: false }, description: "slots: up to 7 days." },
      zone: { type: "string", description: "slots: the time zone." },
      length: { type: "string", description: "slots: how long (30 min)." },
      choices: { type: "array", items: { type: "string" }, description: "matrix: the options weighed, 2 to 4." },
      criteria: { type: "array", items: { type: "object", properties: { label: { type: "string" }, cells: { type: "array", items: { type: "object", properties: { text: { type: "string" }, tone: { type: "string", enum: ["good", "warn", "bad", "neutral"] } }, required: ["text"], additionalProperties: false } } }, required: ["label", "cells"], additionalProperties: false }, description: "matrix: up to 10 rows." },
      path: { type: "string", description: "file: its path." },
      language: { type: "string", description: "file: what it's written in." },
      start: { type: "number", description: "file: the first line's number." },
      marked: { type: "array", items: { type: "number" }, description: "file: the line numbers that matter." },
      events: { type: "array", items: { type: "object", properties: { when: { type: "string" }, title: { type: "string" }, detail: { type: "string" }, tone: { type: "string", enum: ["good", "warn", "bad", "neutral"] }, tag: { type: "string" } }, required: ["when", "title"], additionalProperties: false }, description: "timeline: up to 20, in order." },
    },
    required: ["kind", "title"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, openWorldHint: false },
};

export const UPDATE_UI_TOOL: MeshToolDef = {
  name: "update_ui",
  description:
    "Change part of a card you showed (show_ui), in place, without drawing it again: a run's counts as results come (set: {passed, failed, total, skipped}), failures added (append: {failures: [...]}), done: true when it finishes; a stats card's tiles (set: {tiles}); a timeline's events as they happen (append: {events: [...]}); or any card's title or note (set). The card updates where it is in the chat.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The card's id, from show_ui's answer." },
      set: { type: "object", description: "Fields to replace: title, note, total, passed, failed, skipped, command." },
      append: { type: "object", properties: { failures: { type: "array", items: FAILURE }, events: { type: "array", items: { type: "object" } } }, additionalProperties: false, description: "Failures to add to a run card, or events to a timeline." },
      done: { type: "boolean", description: "A run card: it has finished." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, openWorldHint: false },
};

export const GEN_UI_INSTRUCTIONS =
  " show_ui draws a card in the chat: choices or pictures when the person must pick between a few concrete options (pictures for screenshots), changes after an edit worth their look, run for a test run or build they'd watch (keep it current with update_ui), select when they should tick which rows to act on, goahead before anything outward that needs their yes; for any work, stats for numbers worth a glance, draft for something written for somewhere (an email, a post) before it goes, slots to pick a time, matrix to weigh options, links for pages or pull requests, file for lines of a file, timeline for what happened or will; a table, chart, compare, form or sources where clearer than prose. With wait: true the call returns their press and you carry on. Use one where it is clearer than prose, not for every reply.";

/** The most cards one run draws: a card updated counts once. */
const MAX_CARDS_PER_RUN = 12;
/** How long a waiting call waits for the press, as ask_agent does. */
const WAIT_MS = 4 * 60_000;
const ACTOR = (name: string) => ({ id: "agent", name, kind: "agent" as const });
const FRIDAY = { id: "friday", name: "Friday", kind: "system" as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The fields update_ui may set, per what they are. */
const SETTABLE = new Set(["title", "note", "total", "passed", "failed", "skipped", "command", "tiles"]);

/** Runs git in a folder: its output, or "" when it fails (no repo, no git, a file it doesn't know). */
const gitIn = (cwd: string, args: string[]) => new Promise<string>((resolve) => execFile("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => resolve(e ? "" : String(out))));
const MAX_DIFF = 6000;
const MAX_DIFFS = 40_000;

/** A unified diff from its first hunk on, trimmed to what the chat holds. */
const hunks = (d: string) => ((at) => (at < 0 ? "" : d.slice(at)))(d.search(/^@@/m)).slice(0, MAX_DIFF);

/**
 * The files a changes card names, as the folder's git has them: what was added and taken out, new or deleted, and the hunks. A file
 * since committed is shown as its last commit changed it. Outside the folder, or with no git, it stays as the agent said.
 */
export async function filesFrom(cwd: string | undefined, files: ChangedFile[], git = gitIn): Promise<ChangedFile[]> {
  if (!cwd) return files;
  let budget = MAX_DIFFS;
  const out: ChangedFile[] = [];
  for (const f of files) {
    const rel = path.isAbsolute(f.path) ? path.relative(cwd, f.path) : f.path;
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      out.push(f);
      continue;
    }
    let diff = await git(cwd, ["diff", "--no-color", "--no-ext-diff", "-U3", "HEAD", "--", rel]);
    if (!diff.trim()) {
      const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "--", rel])).trim();
      if (untracked) {
        const body = await readFile(path.join(cwd, rel), "utf8").catch(() => "");
        const lines = body.replace(/\r\n/g, "\n").split("\n");
        if (lines.at(-1) === "") lines.pop();
        const shown = lines.slice(0, 120);
        diff = `@@ -0,0 +1,${lines.length} @@\n${shown.map((l) => `+${l}`).join("\n")}${lines.length > shown.length ? `\n+… ${lines.length - shown.length} more lines` : ""}`;
        const d = hunks(diff).slice(0, Math.max(0, budget));
        budget -= d.length;
        out.push({ path: f.path, status: "new", added: lines.length, removed: 0, ...(d ? { diff: d } : {}) });
        continue;
      }
      // Committed since: as its last commit changed it.
      const sha = (await git(cwd, ["log", "-1", "--format=%H", "--", rel])).trim();
      if (sha) diff = await git(cwd, ["show", "--no-color", "--no-ext-diff", "-U3", "--format=", sha, "--", rel]);
    }
    if (!diff.trim()) {
      out.push(f);
      continue;
    }
    const body = diff.split("\n");
    const added = body.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const removed = body.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    const status = /^new file mode/m.test(diff) ? "new" : /^deleted file mode/m.test(diff) ? "deleted" : "changed";
    const d = hunks(diff).slice(0, Math.max(0, budget));
    budget -= d.length;
    out.push({ path: f.path, status, added, removed, ...(d ? { diff: d } : {}) });
  }
  return out;
}

type Store = Pick<SessionStore, "state" | "events" | "append">;

export function genUiTool(store: Store, opts: { waitMs?: number; poll?: number; git?: typeof gitIn } = {}) {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const poll = opts.poll ?? 600;

  /** Waits for the person's press on card `id`, drawn at `from`: what they said and the values, or null when time ran out. */
  const pressOn = async (sid: string, lane: string, id: string, from: number): Promise<{ text: string; card: unknown } | null> => {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await sleep(poll);
      const events = await store.events(sid);
      const got = events.find((e) => e.seq > from && e.body.type === "instruction" && e.body.card?.id === id && (e.lane ?? MAIN_LANE) === lane);
      if (got?.body.type === "instruction") {
        // Taken back from the queue: this call carries it, so it isn't handed to the agent again as a turn of its own.
        const state = await store.state(sid);
        if (pendingFor(state, lane).includes(got.seq)) await store.append(sid, FRIDAY, { type: "instruction.withdrawn", seq: got.seq }, { lane });
        return { text: got.body.text, card: got.body.card };
      }
      // The run it waits in was stopped: nothing to hand the press to now; it comes as a message.
      if (runOf(await store.state(sid), lane).status !== "running") return null;
    }
    return null;
  };

  const show = async (sid: string, lane: string, args: Record<string, unknown>): Promise<MeshResult> => {
    const got = cleanCard(args);
    if ("error" in got) return { output: got.error, isError: true };
    const [state, events] = await Promise.all([store.state(sid), store.events(sid)]);
    const asked = typeof args.id === "string" ? args.id.trim() : "";
    const mine = events.filter((e) => e.body.type === "ui.card" && (e.lane ?? MAIN_LANE) === lane);
    const before = asked ? mine.findLast((e) => e.body.type === "ui.card" && e.body.id === asked) : undefined;
    if (asked && !before) return { output: `There's no card "${asked}" of yours here. Leave id out to show a new one.`, isError: true };
    if (before && before.body.type === "ui.card" && before.body.card.kind !== got.card.kind) return { output: `Card "${asked}" is a ${before.body.card.kind} card: show a new one for a ${got.card.kind}.`, isError: true };
    if (!before && new Set(mine.filter((e) => e.seq > runOf(state, lane).sinceSeq).map((e) => (e.body.type === "ui.card" ? e.body.id : ""))).size >= MAX_CARDS_PER_RUN)
      return { output: `This run has shown ${MAX_CARDS_PER_RUN} cards already. Say the rest in your reply.`, isError: true };
    const id = asked || randomBytes(4).toString("hex");
    let card: UiCard = got.card;
    if (card.kind === "changes") card = { ...card, files: await filesFrom(state.engines[lane]?.cwd, card.files ?? [], opts.git) };
    if (card.kind === "run") card = { ...card, startedAt: (before?.body.type === "ui.card" ? before.body.card.startedAt : undefined) ?? card.startedAt ?? Date.now() };
    const r = await store.append(sid, ACTOR(laneName(state, lane)), { type: "ui.card", id, card }, { lane });
    if (!r.ok) return { output: "Couldn't show it just now. Say it in your reply instead.", isError: true };
    if (card.wait && ANSWERED.includes(card.kind)) {
      const press = await pressOn(sid, lane, id, r.seq);
      if (press) return { output: `They answered (card ${id}):\n${press.text}\n\nExactly: ${JSON.stringify(press.card)}` };
      return { output: `Shown (id ${id}). No answer yet: it will reach you as a message starting "${pickText(card.title, "")}". Carry on with what doesn't depend on it, or end your turn.` };
    }
    if (card.kind === "run") return { output: `Shown (id ${id}). Keep it current with update_ui as results come, and done: true at the end.` };
    if (ANSWERED.includes(card.kind)) return { output: `Shown (id ${id}). Their answer reaches you as a message starting "${pickText(card.title, "")}", with exactly what they pressed and filled in. End your turn to wait for it, unless there's work that doesn't depend on it.` };
    return { output: `Shown (id ${id}).` };
  };

  const update = async (sid: string, lane: string, args: Record<string, unknown>): Promise<MeshResult> => {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const events = await store.events(sid);
    const last = events.findLast((e) => e.body.type === "ui.card" && e.body.id === id && (e.lane ?? MAIN_LANE) === lane);
    if (!last || last.body.type !== "ui.card") return { output: `There's no card "${id}" of yours here.`, isError: true };
    const was = last.body.card;
    const set = args.set && typeof args.set === "object" ? Object.fromEntries(Object.entries(args.set as Record<string, unknown>).filter(([k]) => SETTABLE.has(k))) : {};
    const add = args.append && typeof args.append === "object" ? (args.append as { failures?: unknown; events?: unknown }) : {};
    const failures = Array.isArray(add.failures) ? [...(was.failures ?? []), ...add.failures].slice(-20) : was.failures;
    const timeline = Array.isArray(add.events) ? [...(was.events ?? []), ...add.events].slice(-20) : was.events;
    const next = { ...was, ...set, ...(failures ? { failures } : {}), ...(timeline ? { events: timeline } : {}), ...(args.done === true ? { done: true } : {}) } as Record<string, unknown>;
    const got = cleanCard(next);
    if ("error" in got) return { output: got.error, isError: true };
    const state = await store.state(sid);
    const card: UiCard = { ...got.card, ...(was.files ? { files: was.files } : {}), ...(was.startedAt ? { startedAt: was.startedAt } : {}) };
    const r = await store.append(sid, ACTOR(laneName(state, lane)), { type: "ui.card", id, card }, { lane });
    return r.ok ? { output: `Updated card ${id}.` } : { output: "Couldn't update it just now.", isError: true };
  };

  return {
    tools: [GEN_UI_TOOL, UPDATE_UI_TOOL],
    instructions: GEN_UI_INSTRUCTIONS,
    call(sid: string, lane: string, args: Record<string, unknown>, name = "show_ui"): Promise<MeshResult> {
      return name === "update_ui" ? update(sid, lane, args) : show(sid, lane, args);
    },
  };
}
