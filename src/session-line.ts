import { doingNow } from "./activity-line.js";
import { fmtTokens, laneLabel, latestPlan } from "./left-off.js";
import { commandFailed } from "./receipt.js";
import { questionsTo, requestsTo, runOf, type SessionState } from "./session/projection.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * The session in one line, and the places in it worth jumping to.
 *
 * A room's header used to say "1 online". What a person wants from it is the state in six words: who is doing what,
 * and how much is waiting on them. The same log also knows where the last diff, question and failure are, which is
 * the fast way back to any of them after an hour of scrolling.
 */

// Cut by what a reader sees as one character, never inside an emoji: "newsletter \ud83d…" was half of one (QA, 2026-10-28; Arun:
// "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
const graphemes = (t: string): string[] => (typeof Intl !== "undefined" && "Segmenter" in Intl ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t), (g) => g.segment) : Array.from(t));
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  const g = graphemes(t);
  return g.length > n ? `${g.slice(0, n - 1).join("")}…` : t;
};
const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

/** How many things in this session wait on this person: a question to them, commands for them to allow, requests for them to answer. */
export function waitingOnMe(state: SessionState, meId: string): number {
  let n = 0;
  n += questionsTo(state, meId).length;
  for (const lane of Object.keys(state.approvals)) {
    const d = lane === MAIN_LANE ? state.driver : state.laneDrivers[lane];
    if (d?.id === meId) n++;
  }
  n += requestsTo(state, meId).length;
  return n;
}

export function stateLine(state: SessionState, events: SessionEvent[], meId: string, now = Date.now()): string {
  const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  const running = lanes.filter((l) => runOf(state, l).status === "running");
  const parts: string[] = [];
  // A question stops the agent dead, whatever the run says it is doing.
  const asked = [...new Set(Object.values(state.openQuestions).map((q) => q.toName))];
  if (asked.length) parts.push(`Waiting on ${asked.join(" and ")}`);
  else if (running.length === 1) {
    const d = doingNow(events, running[0]!);
    parts.push(`${laneLabel(state, running[0]!)} is ${d ? lower(d.text) : "working"}`);
  } else if (running.length > 1) parts.push(`${running.length} agents are working`);
  else if (state.run.status === "waiting_for_human") parts.push("Waiting on a person");
  else if (state.run.status === "error") parts.push("The run stopped on an error");
  else if (state.run.status === "paused") parts.push("Paused");
  else {
    const last = events.findLast((e) => e.body.type === "run.ended");
    parts.push(last ? `Idle · last ran ${ago(now - last.ts)}` : "Nothing has run yet");
  }
  const w = waitingOnMe(state, meId);
  if (w) parts.push(`${w} waiting on you`);
  // What it has cost so far, in the provider's own count: tokens, not dollars, since the price depends on the plan.
  const tokens = events.reduce((n, e) => n + (e.body.type === "agent.message" ? (e.body.tokens ?? 0) : 0), 0);
  if (tokens) parts.push(`${fmtTokens(tokens)} tokens`);
  return parts.join(" · ");
}

export interface Goal {
  seq: number;
  text: string;
  /** Plan steps done and in all, across every agent that wrote one. */
  steps?: { done: number; total: number };
}

/** What this session is for: the first thing a person asked, and how far the plan has got. */
export function goalOf(state: SessionState, events: SessionEvent[]): Goal | null {
  const ask = events.find((e) => e.body.type === "instruction" && e.actor.kind === "human" && !e.body.text.startsWith("[session]"));
  if (!ask || ask.body.type !== "instruction") return null;
  const plans = [MAIN_LANE, ...state.lanes.map((l) => l.id)].flatMap((l) => latestPlan(events, l));
  return { seq: ask.seq, text: clip(ask.body.text, 120), ...(plans.length ? { steps: { done: plans.filter((s) => s.done).length, total: plans.length } } : {}) };
}

export interface JumpTargets {
  diff?: number;
  question?: number;
  failure?: number;
  mine?: number;
  review?: number;
}

/** Where the last diff, question, failure, your last message and the last finished run sit in the log. */
export function jumpTargets(events: SessionEvent[], meId: string): JumpTargets {
  const out: JumpTargets = {};
  for (const e of events) {
    const b = e.body;
    if (b.type === "agent.diff") out.diff = e.seq;
    else if (b.type === "agent.question") out.question = e.seq;
    else if (b.type === "tool.result" && commandFailed(b) === true) out.failure = e.seq;
    else if (b.type === "instruction" && e.actor.id === meId) out.mine = e.seq;
    else if (b.type === "run.ended") out.review = e.seq;
  }
  return out;
}

/** A place the Jump menu offers: what it is, the key after g that goes there, and what is waiting there, in a few words. */
export interface JumpPlace {
  key: "q" | "f" | "d" | "r" | "m";
  label: string;
  seq: number;
  /** "5 files · +24 −4", "npm test", "Done", the words of a message. */
  detail: string;
  ts: number;
}

/**
 * The places, said: not "Last diff" but which files and how much, not "Last failure" but which command. In the order they
 * matter: what is waiting on someone, what broke, what changed, how the last run ended, what you last said.
 */
export function jumpPlaces(events: SessionEvent[], meId: string, work = false): JumpPlace[] {
  const calls = new Map<string, string>();
  let diff: SessionEvent | undefined, question: SessionEvent | undefined, failure: { e: SessionEvent; command: string } | undefined, mine: SessionEvent | undefined, run: SessionEvent | undefined;
  for (const e of events) {
    const b = e.body;
    if (b.type === "agent.message") {
      for (const c of b.toolCalls) {
        if (c.name !== "run_command" && c.name !== "shell") continue;
        try {
          calls.set(c.id, String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? "").trim());
        } catch {
          // Arguments that aren't JSON name no command.
        }
      }
    } else if (b.type === "agent.diff") diff = e;
    else if (b.type === "agent.question") question = e;
    else if (b.type === "tool.result" && commandFailed(b) === true) failure = { e, command: calls.get(b.callId) ?? "" };
    else if (b.type === "instruction" && e.actor.id === meId && !b.text.startsWith("[session]")) mine = e;
    else if (b.type === "run.ended") run = e;
  }
  const out: JumpPlace[] = [];
  if (question?.body.type === "agent.question") out.push({ key: "q", label: "Last question", seq: question.seq, detail: clip(question.body.question, 60), ts: question.ts });
  // In Work, a session's words, not a coder's: no commands, diffs or line counts (QA, 2026-10-28: "Last failure · npm test",
  // "Last diff · Nothing changed").
  if (failure) out.push(work ? { key: "f", label: "Last step that didn't work", seq: failure.e.seq, detail: "One of the agent's steps failed", ts: failure.e.ts } : { key: "f", label: "Last failure", seq: failure.e.seq, detail: failure.command ? clip(failure.command, 60) : "A command failed", ts: failure.e.ts });
  if (diff?.body.type === "agent.diff") {
    const files = diff.body.files;
    const adds = files.reduce((n, f) => n + f.additions, 0);
    const dels = files.reduce((n, f) => n + f.deletions, 0);
    if (work) {
      if (files.length) out.push({ key: "d", label: "Last change", seq: diff.seq, detail: `${files.length} piece${files.length === 1 ? "" : "s"} saved`, ts: diff.ts });
    } else out.push({ key: "d", label: "Last diff", seq: diff.seq, detail: files.length ? `${files.length} file${files.length === 1 ? "" : "s"} · +${adds} −${dels}` : "Nothing changed", ts: diff.ts });
  }
  if (run?.body.type === "run.ended") {
    const word = run.body.outcome === "done" ? "Done" : run.body.outcome === "error" ? "Stopped on an error" : "Waiting on you";
    out.push({ key: "r", label: "Last finished run", seq: run.seq, detail: word, ts: run.ts });
  }
  if (mine?.body.type === "instruction") out.push({ key: "m", label: "My last message", seq: mine.seq, detail: `“${clip(mine.body.text.replace(/\s+/g, " "), 56)}”`, ts: mine.ts });
  return out;
}

// ── the tab, and the end ──

/** What the tab's icon should say at a glance: this person is needed, an agent is working, or the last run finished well. */
export type TabStatus = "needs-you" | "working" | "done";
export function tabStatus(state: SessionState, events: SessionEvent[], attention: number): TabStatus | null {
  if (attention > 0) return "needs-you";
  if (state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running")) return "working";
  const last = events.findLast((e) => e.body.type === "run.ended");
  return last && last.body.type === "run.ended" && last.body.outcome === "done" && state.run.status === "idle" ? "done" : null;
}
export const TAB_DOT: Record<TabStatus, string> = { "needs-you": "#f2b453", working: "#a898ff", done: "#4fd1a1" };
/** The site's icon with a dot in its corner, as an SVG string ready for a data URL. */
export function badgeFavicon(svg: string, color: string): string {
  return svg.replace(/<\/svg>\s*$/, `<circle cx="143" cy="51" r="8.5" fill="${color}" stroke="#141416" stroke-width="2"/></svg>`);
}

/** The session in numbers, for the card at its end: how long it took, how many runs, who, and what it cost. */
export function recapStats(events: SessionEvent[], at: number): string[] {
  const first = events.find((e) => e.body.type === "instruction" && e.actor.kind === "human");
  const runs = events.filter((e) => e.body.type === "run.ended").length;
  const tokens = events.reduce((n, e) => n + (e.body.type === "agent.message" ? (e.body.tokens ?? 0) : 0), 0);
  const people = new Set(events.filter((e) => e.actor.kind === "human").map((e) => e.actor.id)).size;
  const days = first ? Math.max(1, Math.round((at - first.ts) / 86_400_000)) : 0;
  return [...(days ? [`${days} day${days === 1 ? "" : "s"} from the first message`] : []), `${runs} run${runs === 1 ? "" : "s"}`, ...(people > 1 ? [`${people} people`] : []), ...(tokens ? [`${fmtTokens(tokens)} tokens`] : [])];
}
