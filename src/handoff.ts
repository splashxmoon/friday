import { engineName, MAIN_LANE, type DiffFile, type EventBody, type SessionEvent } from "./types.js";
import { laneName } from "./session/core.js";
import type { SessionState } from "./session/projection.js";

/**
 * The thinking behind passing work between agents, kept apart from the plumbing so it can be read, and tested, on
 * its own: who "the reviewer" means, what should go along without being asked, and when two agents are only
 * passing the same thing back and forth.
 */

/** What one lane is, in a line an agent (or a person) can choose by. */
export function describeLane(state: SessionState, id: string): string {
  const engine = state.engines[id];
  const lane = id === MAIN_LANE ? null : state.lanes.find((l) => l.id === id);
  const agent = id === MAIN_LANE ? state.options.agent : lane?.agent;
  if (engine?.tool) return `${engineName(engine.tool)} on ${engine.hostName}'s machine`;
  const said = (agent?.instructions ?? "").replace(/\s+/g, " ").trim();
  if (said) return said.length > 90 ? `${said.slice(0, 89)}…` : said;
  return id === MAIN_LANE ? "Friday Code" : "an agent";
}

const WORDS = /[a-z][a-z0-9+#.-]{2,}/g;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "you", "your", "are", "was", "has", "have", "from", "into", "when", "then", "than", "will", "its", "any", "all", "not", "but", "out", "can", "one", "now", "who", "what", "how", "should", "would", "could", "agent", "work", "take", "does", "doing"]);
const words = (t: string) => new Set((t.toLowerCase().match(WORDS) ?? []).filter((w) => !STOP.has(w)));

/** The text a lane can be recognised by: its name, the tool behind it, and what it was written to do. */
function profile(state: SessionState, id: string): string {
  const lane = id === MAIN_LANE ? null : state.lanes.find((l) => l.id === id);
  const agent = id === MAIN_LANE ? state.options.agent : lane?.agent;
  const engine = state.engines[id];
  return [laneName(state, id), engine?.tool ? engineName(engine.tool) : "", agent?.name ?? "", agent?.instructions ?? ""].join(" ");
}

export type Resolved = { ok: true; to: string; how: "named" | "matched" | "suggested" } | { ok: false; error: string };

/**
 * Who "to" means.
 *
 * The name as the session shows it, first. Then however a person would say it: "claude" for Maya's Claude Code,
 * "review" for the Reviewer, a unique piece of a name. With nothing usable, or nothing matching, the agent that
 * is plainly the best fit for the task, when one is. Otherwise a refusal that says what each choice is for, so the
 * next attempt is a good one instead of another guess.
 */
export function resolveTarget(state: SessionState, from: string, query: string, task = "", may: (id: string) => boolean = () => true): Resolved {
  const all = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((id) => id !== from);
  const q = query.trim().toLowerCase();
  const exact = all.find((id) => laneName(state, id).toLowerCase() === q || id.toLowerCase() === q);
  if (exact) return { ok: true, to: exact, how: "named" };
  // A guess never lands on a lane this run may not hand work to; naming one exactly gets the reason why not.
  const ids = all.filter(may);

  if (q) {
    const parts = q.split(/[^a-z0-9]+/).filter((p) => p.length >= 3);
    const partial = ids.filter((id) => {
      const label = `${laneName(state, id)} ${state.engines[id]?.tool ? engineName(state.engines[id]!.tool!) : ""}`.toLowerCase();
      return label.includes(q) || (parts.length > 0 && parts.every((p) => label.includes(p)));
    });
    if (partial.length === 1) return { ok: true, to: partial[0]!, how: "matched" };
    if (partial.length > 1) {
      return { ok: false, error: `"${query}" could mean ${partial.map((id) => `"${laneName(state, id)}"`).join(" or ")}. Say which.` };
    }
  }

  // Nothing named: the best fit for the work, if one stands clear of the rest.
  const want = words(`${query} ${task}`);
  const scored = ids
    .map((id) => {
      const have = words(profile(state, id));
      let n = 0;
      for (const w of want) if (have.has(w)) n++;
      return { id, n };
    })
    .sort((a, b) => b.n - a.n);
  if (scored[0] && scored[0].n >= 2 && scored[0].n > (scored[1]?.n ?? 0)) return { ok: true, to: scored[0].id, how: "suggested" };

  if (!ids.length) return { ok: false, error: all.length ? "Every other agent here is someone else's to steer, so there is nobody I can hand this to. Ask in chat." : "There is no other agent in this session to hand off to." };
  const menu = ids.map((id) => `"${laneName(state, id)}" (${describeLane(state, id)})`).join("; ");
  return { ok: false, error: `${q ? `There's no agent called "${query}" here.` : "Say who to hand off to."} You can hand off to: ${menu}.` };
}

/** Short, human lines for what a lane has done, from the log, for whoever picks the work up. */
export function establishedBy(state: SessionState, from: string): string[] {
  const lines: string[] = [];
  const files = state.diffs[from]?.files ?? [];
  if (files.length) {
    const shown = files.slice(0, 5).map((f) => `${f.path}${f.additions || f.deletions ? ` (+${f.additions} −${f.deletions})` : ""}`);
    lines.push(`Changed ${shown.join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`);
  }
  const q = state.openQuestions[from];
  if (q) lines.push(`A question is open with ${q.toName}: ${q.question.slice(0, 160)}`);
  return lines;
}

/**
 * What goes along: the agent's own lines first, then whatever the log knows that it left out. Nothing is added
 * twice, a file the agent already named is not listed again, and the total stays short enough to be read.
 */
export function carriedFor(state: SessionState, from: string, given: string[]): string[] {
  const own = given.map((c) => c.trim()).filter(Boolean);
  const said = own.join("\n").toLowerCase();
  const extra = establishedBy(state, from).filter((line) => {
    if (!line.startsWith("Changed ")) return !said.includes(line.slice(0, 40).toLowerCase());
    // the files line is redundant only if the agent already named every file
    const paths = (state.diffs[from]?.files ?? []).map((f) => f.path.toLowerCase());
    return !paths.every((p) => said.includes(p));
  });
  return [...own, ...extra].slice(0, 8);
}

/** How many times work has gone between these two lanes lately, either way. */
export function bouncesBetween(events: SessionEvent[], a: string, b: string, since: number): number {
  let n = 0;
  for (const e of events) {
    const body = e.body as EventBody;
    if (e.ts < since || body.type !== "instruction" || !body.handoff) continue;
    const to = e.lane ?? MAIN_LANE;
    const from = body.handoff.fromLane;
    if ((from === a && to === b) || (from === b && to === a)) n++;
  }
  return n;
}

/** Past this, two agents are passing one thing back and forth, and a person should look. */
export const MAX_BOUNCES = 4;
export const BOUNCE_WINDOW_MS = 20 * 60_000;

/**
 * Everything the agent handing over already knows, for the one taking over.
 *
 * A handoff used to carry a reason and a few short lines, so the next tool started by reading every file again to find out
 * what the first had just found: a minute and tens of thousands of tokens spent rediscovering it, and sometimes reaching a
 * different conclusion. Two different tools can't share a memory, but the session recorded what the first one did: what it
 * was asked, every file it opened, every search and command and how each went, what it wrote along the way, its whole
 * answer, and the changes it left. That record is handed over whole, from the log alone (no model call, so it is instant
 * and can't invent anything), with the plain instruction to build on it rather than redo it.
 */

/** Characters of brief, all in: a long answer and a large change are worth carrying, a whole log is not. */
const BRIEF_BUDGET = 24_000;
/** How many of the first agent's latest runs the brief covers: its current piece of work, not the session's history. */
const BRIEF_RUNS = 3;

const flat = (t: string) => t.replace(/\s+/g, " ").trim();
const clipTo = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const argsOf = (raw: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Files a shell command reads: `Get-Content x`, `cat x`, `sed -n '1,80p' x`, `head x`, `type x`, and paths an rg/grep is aimed at. */
export function pathsReadBy(command: string): string[] {
  const out: string[] = [];
  for (const part of command.split(/;|&&|\|\||\|/)) {
    const words = part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const verb = (words[0] ?? "").toLowerCase();
    if (!/^(get-content|gc|cat|type|sed|head|tail|less|more|rg|grep|select-string|nl|bat)$/.test(verb)) continue;
    for (const w of words.slice(1)) {
      const p = w.replace(/^["']|["']$/g, "");
      if (!p || p.startsWith("-") || /^\d+(,\d+)?p?$/.test(p) || /^\$/.test(p)) continue;
      // A path: has a separator or an extension, and isn't a pattern or a bare word.
      if ((/[\\/]/.test(p) || /\.[A-Za-z0-9]{1,8}$/.test(p)) && !/[*?[\]{}()|^]/.test(p) && p.length < 300) out.push(p.replace(/\\/g, "/"));
    }
  }
  return out;
}

/**
 * The brief for a handoff from `from`, given before event `before` (the handoff itself). Empty when the first agent did
 * nothing yet worth carrying.
 */
export function handoffBrief(events: SessionEvent[], from: string, before: number): string {
  const lane = (e: SessionEvent) => (e.lane ?? MAIN_LANE) === from;
  const mine = events.filter((e) => e.seq < before && lane(e));
  const starts = mine.filter((e) => e.body.type === "run.started");
  const since = starts.length > BRIEF_RUNS ? starts[starts.length - BRIEF_RUNS]!.seq : 0;
  const window = mine.filter((e) => e.seq >= since);
  if (!window.some((e) => e.body.type === "agent.message")) return "";

  const asked: string[] = [];
  const notes: string[] = [];
  let answer = "";
  const read = new Set<string>();
  const searched = new Set<string>();
  const ran: { command: string; ok: boolean | null }[] = [];
  const byCall = new Map<string, { command: string; ok: boolean | null }>();
  let diff: DiffFile[] = [];

  for (const e of window) {
    const b = e.body;
    if (b.type === "instruction" && !b.approval) asked.push(`${e.actor.name}: ${clipTo(flat(b.text), 600)}`);
    else if (b.type === "agent.diff") diff = b.files;
    else if (b.type === "tool.result") {
      const r = byCall.get(b.callId);
      if (r) r.ok = !b.isError;
    } else if (b.type === "agent.message") {
      const said = b.text.trim();
      if (said) {
        // The last words without tool calls are its answer; words beside tool calls are what it noticed along the way.
        if (!b.toolCalls.length) {
          if (answer) notes.push(answer);
          answer = said;
        } else notes.push(said);
      }
      for (const c of b.toolCalls) {
        const a = argsOf(c.arguments);
        if (c.name === "read" || c.name === "read_file") {
          if (text(a.path)) read.add(text(a.path).replace(/\\/g, "/"));
        } else if (c.name === "search" || c.name === "search_code") {
          const what = text(a.pattern) || text(a.query);
          if (what) searched.add(`${clipTo(flat(what), 80)}${text(a.path) ? ` in ${text(a.path)}` : ""}`);
        } else if (c.name === "shell" || c.name === "run_command") {
          const command = flat(text(a.command));
          if (!command) continue;
          for (const p of pathsReadBy(command)) read.add(p);
          const row = { command: clipTo(command, 160), ok: null as boolean | null };
          ran.push(row);
          byCall.set(c.id, row);
        }
      }
    }
  }

  const parts: string[] = [];
  let room = BRIEF_BUDGET;
  const add = (title: string, body: string) => {
    if (!body.trim() || room < 200) return;
    const piece = `${title}\n${body.length > room - title.length - 2 ? `${body.slice(0, room - title.length - 3)}…` : body}`;
    parts.push(piece);
    room -= piece.length + 2;
  };

  add("What it was asked:", asked.slice(-6).map((a) => `- ${a}`).join("\n"));
  // Its answer whole: the plan, the findings, the numbers. This is the part the next agent would otherwise redo.
  if (answer) add("What it concluded (its own words):", clipTo(answer, 9_000));
  if (read.size) add("Files it already read (don't reopen these to rediscover what's above; open one only to change it or check a detail):", [...read].slice(0, 80).map((p) => `- ${p}`).join("\n"));
  if (searched.size) add("Searches it ran:", [...searched].slice(0, 20).map((s) => `- ${s}`).join("\n"));
  if (ran.length) add("Commands it ran:", ran.slice(-25).map((r) => `- ${r.ok === false ? "failed" : r.ok ? "ok" : "no result"}: ${r.command}`).join("\n"));
  if (diff.length) {
    const list = diff.map((f) => `- ${f.path} (${f.status}, +${f.additions} −${f.deletions})`).join("\n");
    add("What it changed:", list);
    // The changes themselves, while they fit: the next agent sees what was done without reading the files back.
    const patches = diff.map((f) => f.patch).filter(Boolean).join("\n");
    if (patches && patches.length <= Math.min(10_000, room - 400)) add("The changes:", patches);
  }
  // Newest notes first to survive: what it noticed last is closest to where it stopped.
  if (notes.length) {
    const kept: string[] = [];
    let used = 0;
    for (const n of [...notes].reverse()) {
      const line = `- ${clipTo(flat(n), 700)}`;
      if (used + line.length > Math.min(5_000, room - 300)) break;
      kept.unshift(line);
      used += line.length + 1;
    }
    add("What it noticed along the way, oldest first:", kept.join("\n"));
  }
  return parts.join("\n\n");
}
