import type { Redis } from "ioredis";
import { BENCH_ASOF, benchFor } from "./model-bench.js";

/** Friday Pro's model id: the hosted Friday's; the open-source edition has no Friday models, so nothing is learnt for them. */
let FRIDAY_PRO = "\u0000none";
import { commandFailed, receiptOf, type Receipt } from "./receipt.js";
import { repoNameOf } from "./repo-key.js";
import { tookCheckpoint } from "./rewind.js";
import type { RunRecord } from "./forecast.js";
import { KIND_WORDS, type TaskKind } from "./strengths.js";
import { ENGINE_MODEL_INFO, engineName, MAIN_LANE, type DiffFile, type EngineTool, type EventBody, type SessionEvent, type ToolCall } from "./types.js";

/**
 * What routing learns from how runs end here (routing.ts).
 *
 * Benchmarks are measured on someone else's harness and someone else's code. So each workspace keeps, for every model and kind of
 * task, how many runs there were and how well they went, and routing weighs that against the benchmark figure as ten runs' worth
 * of evidence: a few outcomes nudge the estimate, many outweigh it. Kept twice over: for the workspace, and for the repo the run
 * was on, each shrinking toward the level above, so a repo with a handful of runs moves a little and one with fifty stands on
 * its own.
 *
 * A run is graded, not counted: "done" is a sentence the model said, and the evidence under it is what the grade reads. Tests
 * that ran and passed grade 1; none ran, 0.8; ran and failed, 0.25; an error, 0. What comes later revises it: a second review
 * that found something serious halves it, an undo sets it to 0, the next message reading as a correction ("still fails") takes
 * it down to 0.25, a thumbs-down to 0.5 and a thumbs-up back to 1. A run that failed for an account reason (an allowance
 * spent, a sign-in) teaches nothing about the model.
 *
 * What a run ran on is the pick said before it (model.routed): the model a lane was started with for a coding tool, what Auto
 * picked or the session's model for Friday's agent. Kept per benchmark table (BENCH_ASOF), so a refreshed table starts afresh.
 */

/** Outcomes per `${tool}:${model}:${tier}`, and per `${tool}:${model}:${tier}@${repo}`: runs, and the grades of those runs added up. */
export type Learned = Record<string, { n: number; ok: number; /** Dollars spent over those runs, when measured (forecast.ts). */ c?: number; /** Milliseconds taken over those runs, when measured. */ ms?: number }>;

/** Older than this, a run says little about how the tools work now: forecasts and learning from records leave it out. */
export const KEEP_MS = 60 * 86_400_000;

/** How many runs the level above is worth: the benchmark to a workspace, the workspace to one of its repos. */
export const PRIOR_RUNS = 10;

/**
 * A success rate from its benchmark estimate and the runs seen at each level below it, most general first: the workspace, the
 * repo, the repo's runs of this kind of task. Each shrinks toward the one above.
 */
export function learnedSuccess(prior: number, ...levels: ({ n: number; ok: number } | undefined)[]): number {
  const shrink = (p: number, s?: { n: number; ok: number }) => (!s?.n ? p : (PRIOR_RUNS * p + Math.max(0, Math.min(s.n, s.ok))) / (PRIOR_RUNS + s.n));
  return levels.reduce((p, s) => shrink(p, s), prior);
}

/** What each coding tool runs with no model picked: Claude Code's default is Opus on every plan, Codex's its recommended model. */
export const TOOL_DEFAULT: Record<string, string> = { claude: "opus", codex: "gpt-6.1-sol" };

type Routed = Extract<EventBody, { type: "model.routed" }>;

/** The model a run ran on, in routing's terms; null for one routing has no figures for. */
export function ranOn(b: Routed): { tool: string; model: string } | null {
  const tool = b.tool ?? "friday";
  if (tool === "friday") {
    const id = b.shadow ? (b.current ?? "") : b.model;
    return id === "" ? { tool, model: "base" } : id === FRIDAY_PRO ? { tool, model: "pro" } : null;
  }
  // A shadow pick names what would have run; the lane ran its own model. An Auto lane's pick is what ran.
  const id = b.shadow ? b.current || TOOL_DEFAULT[tool] || "" : b.model;
  return benchFor(tool, id) ? { tool, model: id } : null;
}

/** An error that says nothing about how well the model works: the account, or the connection to the machine it ran on. */
export const NOT_THE_MODEL = /allowance|team pro|on team|plan|sign(ed)? in|log(ged)? in|logged out|authenticat|credits|quota|rate limit|disconnected|lost its connection|reconnects/i;

/** A message that says the last run missed: the same thing asked again, with the words of someone who saw it fail. */
export const CORRECTION = /\b(still (fails|failing|broken|wrong|doesn'?t)|doesn'?t work|not working|that'?s (wrong|not it)|try again|didn'?t (fix|work)|same error)\b/i;

/** What a run's outcome teaches, and how it changes what an earlier grade for the same run said. */
export interface Lesson {
  /** `${tool}:${model}:${tier}`. */
  key: string;
  /** The run, as `${lane}:${seq of its end}`: what a later signal revises. */
  run: string;
  grade: number;
  /** How `grade` meets the grade the run already has: not at all (a new run), or set to it, the lower, the higher, or times it. */
  replace?: "set" | "min" | "max" | "mul";
  /** The repo the run was on (the brain's key), for the repo's own count. */
  repo?: string;
}

const onLane = (e: Pick<SessionEvent, "lane">, lane: string) => (e.lane ?? MAIN_LANE) === lane;

/** The pick said before `seq` on this lane, as the key the outcome is kept under; null when routing had no figures for it. */
function keyBefore(events: SessionEvent[], seq: number, lane: string): string | null {
  const routed = events.findLast((e) => e.seq < seq && onLane(e, lane) && e.body.type === "model.routed");
  if (!routed || routed.body.type !== "model.routed") return null;
  const r = ranOn(routed.body);
  return r ? `${r.tool}:${r.model}:${routed.body.tier}` : null;
}

/**
 * How well a run that ended "done" went, from its receipt (receipt.ts): the commands it ran and whether its tests passed. Tests
 * that passed, 1; none ran, 0.8 (the model's word, unchecked); tests that failed, 0.25 (it said done over a failing suite).
 */
export function gradeOf(events: SessionEvent[], lane: string, endSeq: number): number {
  const r = runReceipt(events, lane, endSeq);
  return r.tests === "pass" ? 1 : r.tests === "fail" ? 0.25 : 0.8;
}

/** The receipt of the run that ended at `endSeq` on this lane (receipt.ts): the commands it ran, whether its tests passed, its files. */
export function runReceipt(events: SessionEvent[], lane: string, endSeq: number): Receipt {
  const start = events.findLast((e) => e.seq < endSeq && onLane(e, lane) && e.body.type === "run.started")?.seq ?? 0;
  const run = events.filter((e) => e.seq > start && e.seq <= endSeq && onLane(e, lane));
  const calls: ToolCall[] = run.flatMap((e) => (e.body.type === "agent.message" ? e.body.toolCalls : []));
  const results = new Map<string, boolean | null>();
  for (const e of run) if (e.body.type === "tool.result") results.set(e.body.callId, commandFailed(e.body));
  const diff = run.findLast((e) => e.body.type === "agent.diff");
  const files: DiffFile[] = diff?.body.type === "agent.diff" ? diff.body.files : [];
  const answer = run.findLast((e) => e.body.type === "agent.message" && !e.body.toolCalls.length && !!e.body.text);
  return receiptOf({ calls, failed: (id) => results.get(id) ?? null, files, ...(answer?.body.type === "agent.message" ? { answer: answer.body.text } : {}) });
}

/** The run (as `lane:seq`) and the key for the run that ended at `end`, or null when there is nothing routing can learn from it. */
function runOf(events: SessionEvent[], end: Pick<SessionEvent, "seq" | "lane" | "body">): { key: string; run: string; lane: string } | null {
  const lane = end.lane ?? MAIN_LANE;
  const key = keyBefore(events, end.seq, lane);
  return key ? { key, run: `${lane}:${end.seq}`, lane } : null;
}

/** The run a folder restore undid: the one whose start took the checkpoint being put back, if it ended done. */
function undone(events: SessionEvent[], ev: Pick<SessionEvent, "seq" | "lane" | "body">): SessionEvent | null {
  if (ev.body.type !== "folder.restored") return null;
  const sha = ev.body.sha;
  const start = events.findLast((e) => e.seq < ev.seq && tookCheckpoint(e, sha));
  if (!start) return null;
  const lane = start.lane ?? MAIN_LANE;
  const ended = events.find((e) => e.seq > start.seq && onLane(e, lane) && e.body.type === "run.ended");
  return ended?.body.type === "run.ended" && ended.body.outcome === "done" ? ended : null;
}

/** A run's end, and the grade an event gives it: a new run's (no `replace`), or how it revises the grade the run already has. */
type Judged = { end: Pick<SessionEvent, "seq" | "lane" | "body">; grade: number; replace?: Lesson["replace"] };

function judged(events: SessionEvent[], ev: Pick<SessionEvent, "seq" | "lane" | "body" | "actor">): Judged | null {
  const b = ev.body;
  if (b.type === "run.ended") {
    if (b.outcome === "error" && NOT_THE_MODEL.test(b.error ?? "")) return null;
    // Stopped to ask a person: neither right nor wrong yet.
    if (b.outcome === "waiting") return null;
    return { end: ev, grade: b.outcome === "error" ? 0 : gradeOf(events, ev.lane ?? MAIN_LANE, ev.seq) };
  }
  if (b.type === "folder.restored") {
    const ended = undone(events, ev);
    return ended ? { end: ended, grade: 0, replace: "set" } : null;
  }
  if (b.type === "review.done") {
    const ended = events.find((e) => e.seq === b.runSeq && e.body.type === "run.ended");
    if (!ended) return null;
    const worst = b.findings.some((f) => f.severity === "high") ? 0.5 : b.findings.some((f) => f.severity === "medium") ? 0.75 : null;
    return worst === null ? null : { end: ended, grade: worst, replace: "mul" };
  }
  if (b.type === "message.reacted") {
    if (b.up === null) return null;
    const said = events.find((e) => e.seq === b.seq && e.body.type === "agent.message");
    if (!said) return null;
    const lane = said.lane ?? MAIN_LANE;
    const ended = events.find((e) => e.seq > said.seq && onLane(e, lane) && e.body.type === "run.ended");
    return ended ? { end: ended, grade: b.up ? 1 : 0.5, replace: b.up ? "max" : "min" } : null;
  }
  if (b.type === "instruction") {
    // A person, in their own words, saying the last run missed; not a hand-off, a message from another session, or an answer.
    if (ev.actor.kind !== "human" || b.handoff || b.peer || b.approval || !CORRECTION.test(b.text)) return null;
    const lane = ev.lane ?? MAIN_LANE;
    const prev = events.findLast((e) => e.seq < ev.seq && onLane(e, lane) && (e.body.type === "run.ended" || (e.body.type === "instruction" && e.actor.kind === "human")));
    if (!prev || prev.body.type !== "run.ended" || prev.body.outcome !== "done") return null;
    return { end: prev, grade: 0.25, replace: "min" };
  }
  return null;
}

/**
 * What an event teaches routing, if anything: a run's end and its grade; or a revision of a run's grade, from an undo, a second
 * review's findings, a correction in the next message, or a reaction to what the run said. Null when there is nothing to learn.
 */
export function lessonOf(events: SessionEvent[], ev: Pick<SessionEvent, "seq" | "lane" | "body" | "actor">, repo?: string): Lesson | null {
  const j = judged(events, ev);
  const r = j && runOf(events, j.end);
  if (!j || !r) return null;
  return { key: r.key, run: r.run, grade: j.grade, ...(j.replace ? { replace: j.replace } : {}), ...(repo ? { repo } : {}) };
}

/**
 * A later word on a run's record (forecast.ts RunLog): everything lessonOf revises, and the board's check of a task, which
 * passing raises to 1 and sending back lowers to 0.5. The run as `${lane}:${seq of its end}`; null for a run's own end.
 */
export function revisionOf(events: SessionEvent[], ev: Pick<SessionEvent, "seq" | "lane" | "body" | "actor">): { run: string; grade: number; replace: NonNullable<Lesson["replace"]> } | null {
  if (ev.body.type === "board.reviewed") {
    const lane = ev.body.lane;
    const ended = events.findLast((e) => e.seq < ev.seq && onLane(e, lane) && e.body.type === "run.ended" && e.body.outcome === "done");
    return ended ? { run: `${lane}:${ended.seq}`, grade: ev.body.ok ? 1 : 0.5, replace: ev.body.ok ? "max" : "min" } : null;
  }
  const j = judged(events, ev);
  if (!j?.replace) return null;
  return { run: `${j.end.lane ?? MAIN_LANE}:${j.end.seq}`, grade: j.grade, replace: j.replace };
}

/**
 * Whether the last run on this lane missed, as the next pick should know (routing.ts escalates): it ended in an error that was the
 * model's, or done with its tests failing, or was undone since, or the message now being sent reads as a correction of it.
 */
export function missedLast(events: SessionEvent[], lane: string, next = ""): boolean {
  const end = events.findLast((e) => onLane(e, lane) && e.body.type === "run.ended");
  if (!end || end.body.type !== "run.ended") return false;
  if (end.body.outcome === "error") return !NOT_THE_MODEL.test(end.body.error ?? "");
  if (end.body.outcome !== "done") return false;
  if (CORRECTION.test(next)) return true;
  if (events.some((e) => e.seq > end.seq && e.body.type === "folder.restored" && undone(events, e)?.seq === end.seq)) return true;
  return gradeOf(events, lane, end.seq) < 0.5;
}

/** The outcomes, kept in Redis per workspace and benchmark table. */
export class RouteStats {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private key(workspaceId: string): string {
    return `${this.prefix}routestats:${BENCH_ASOF}:${workspaceId}`;
  }

  /** A run's grade, kept a day, so what comes later (a review, an undo, a correction) revises it rather than counting again. */
  private runKey(workspaceId: string, sid: string, run: string): string {
    return `${this.key(workspaceId)}:run:${sid}:${run}`;
  }

  async learn(workspaceId: string, lesson: Lesson, sid = ""): Promise<void> {
    const k = this.key(workspaceId);
    const keys = [lesson.key, ...(lesson.repo ? [`${lesson.key}@${lesson.repo}`] : [])];
    const runKey = this.runKey(workspaceId, sid, lesson.run);
    if (!lesson.replace) {
      for (const key of keys) {
        await this.redis.hincrbyfloat(k, `${key}|n`, 1);
        await this.redis.hincrbyfloat(k, `${key}|ok`, lesson.grade);
      }
      await this.redis.set(runKey, String(lesson.grade), "EX", 86_400);
      return;
    }
    // A run whose grade is no longer kept is taken to have counted in full, as a done run used to.
    const was = Number((await this.redis.get(runKey)) ?? "1");
    const next = lesson.replace === "set" ? lesson.grade : lesson.replace === "min" ? Math.min(was, lesson.grade) : lesson.replace === "max" ? Math.max(was, lesson.grade) : was * lesson.grade;
    if (next === was) return;
    for (const key of keys) await this.redis.hincrbyfloat(k, `${key}|ok`, next - was);
    await this.redis.set(runKey, String(next), "EX", 86_400);
  }

  /** Everything learnt for the workspace, forgotten (a person's reset of all routing learned, RunLog.reset "*"). */
  async clear(workspaceId: string): Promise<void> {
    await this.redis.del(this.key(workspaceId));
  }

  async get(workspaceId: string): Promise<Learned> {
    const h = await this.redis.hgetall(this.key(workspaceId)).catch(() => ({}) as Record<string, string>);
    const out: Learned = {};
    for (const [field, v] of Object.entries(h)) {
      const at = field.lastIndexOf("|");
      const key = field.slice(0, at);
      const which = field.slice(at + 1);
      if (!key || (which !== "n" && which !== "ok")) continue;
      (out[key] ??= { n: 0, ok: 0 })[which] = Number(v) || 0;
    }
    return out;
  }
}

// ── learning from run records (forecast.ts) ─────────────────────────

/** Whether a reset (RunLog.reset) has put this record out of what is learnt: everything, or its repo and kind of task. */
const resetOut = (r: RunRecord, resets: Record<string, number>) => r.at <= (resets["*"] ?? 0) || r.at <= (resets[scopeOf(r)] ?? 0);
/** A learned preference's scope: a repo and a kind of task. */
export const scopeOf = (r: Pick<RunRecord, "repo" | "kind">) => `${r.repo ?? ""}|${r.kind ?? "other"}`;

/** The records learning stands on: under the current benchmark table, recent, and not reset since. */
export function learnable(records: RunRecord[], resets: Record<string, number>, now = Date.now()): RunRecord[] {
  return records.filter((r) => r.asof === BENCH_ASOF && now - r.at < KEEP_MS && !!r.model && !resetOut(r, resets));
}

/**
 * What routing learns from run records, as fitModels reads it: per model and tier, for the workspace and the repo (`all`, where
 * nothing else keeps those: the open-source edition), and always for the repo's runs of each kind of task
 * (`${tool}:${model}:${tier}#${kind}@${repo}`), with the dollars and time those runs took.
 */
export function learnedFrom(records: RunRecord[], resets: Record<string, number>, levels: "all" | "kind", now = Date.now()): Learned {
  const out: Learned = {};
  const add = (key: string, r: RunRecord) => {
    const l = (out[key] ??= { n: 0, ok: 0, c: 0, ms: 0 });
    l.n += 1;
    l.ok += r.grade;
    l.c! += r.cost;
    l.ms! += r.ms;
  };
  for (const r of learnable(records, resets, now)) {
    const key = `${r.tool}:${r.model}:${r.tier}`;
    if (levels === "all") {
      add(key, r);
      if (r.repo) add(`${key}@${r.repo}`, r);
    }
    if (r.repo && r.kind) add(`${key}#${r.kind}@${r.repo}`, r);
  }
  return out;
}

/** One thing routing has learnt, said in a line, with the scope a reset forgets. */
export interface LearnedItem {
  scope: string;
  repo: string;
  kind: TaskKind | null;
  text: string;
  runs: number;
}

/** Runs an option needs in a repo and kind of task before anything is said about it. */
const SAY_AFTER = 3;

const toolWords = (tool: string) => (tool === "friday" ? "Friday" : engineName(tool as EngineTool));

/**
 * What routing has learnt, in words a person can check: for each repo and kind of task with two options run there at least
 * SAY_AFTER times each, how the better one compares ("In acme/api, Codex finishes tests 30% faster at half the cost of Claude
 * Code"). Options are tools, or models when only one tool ran there. Nothing is said where neither is better on any count.
 */
export function learnedView(records: RunRecord[], resets: Record<string, number>, now = Date.now()): LearnedItem[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of learnable(records, resets, now)) {
    if (!r.repo) continue;
    const g = groups.get(scopeOf(r)) ?? [];
    g.push(r);
    groups.set(scopeOf(r), g);
  }
  const items: LearnedItem[] = [];
  for (const [scope, rs] of groups) {
    const tools = new Set(rs.map((r) => r.tool));
    const byTool = tools.size > 1;
    const opts = new Map<string, RunRecord[]>();
    for (const r of rs) {
      const k = byTool ? r.tool : `${r.tool}:${r.model}`;
      opts.set(k, [...(opts.get(k) ?? []), r]);
    }
    const stats = [...opts.entries()]
      .filter(([, x]) => x.length >= SAY_AFTER)
      .map(([k, x]) => {
        const [tool, model] = k.split(":");
        const label = model ? (benchName(tool!, model) ?? model) : toolWords(tool!);
        return { label, n: x.length, ok: x.reduce((a, r) => a + r.grade, 0) / x.length, ms: median(x.map((r) => r.ms)), cost: median(x.map((r) => r.cost)) };
      });
    if (stats.length < 2) continue;
    const maxMs = Math.max(...stats.map((s) => s.ms), 1);
    const maxCost = Math.max(...stats.map((s) => s.cost), 0.0001);
    const score = (s: (typeof stats)[number]) => s.ok - 0.1 * (s.ms / maxMs) - 0.1 * (s.cost / maxCost);
    const ranked = [...stats].sort((a, b) => score(b) - score(a));
    const best = ranked[0]!;
    const other = ranked.slice(1).sort((a, b) => b.n - a.n)[0]!;
    const [repo, kindRaw] = [scope.slice(0, scope.lastIndexOf("|")), scope.slice(scope.lastIndexOf("|") + 1)];
    const kind = kindRaw === "other" ? null : (kindRaw as TaskKind);
    const what = kind ? KIND_WORDS[kind] : "other tasks";
    const surer = best.ok - other.ok >= 0.1;
    const faster = 1 - best.ms / Math.max(other.ms, 1);
    const ratio = other.cost > 0 ? best.cost / other.cost : 1;
    const speed = faster >= 0.2 ? `${Math.round(faster * 100)}% faster` : "";
    const cost = ratio <= 0.7 ? (ratio >= 0.45 && ratio <= 0.55 ? "at half the cost" : `at ${Math.round((1 - ratio) * 100)}% less cost`) : "";
    let says = "";
    if (surer) says = `gets ${what} right ${Math.round(best.ok * 100)}% of the time to ${other.label}'s ${Math.round(other.ok * 100)}%${speed ? `, ${speed}` : ""}${cost ? `, ${cost}` : ""}`;
    else if (speed && cost) says = `finishes ${what} ${speed} ${cost} of ${other.label}`;
    else if (speed) says = `finishes ${what} ${speed} than ${other.label}`;
    else if (cost) says = `does ${what} ${cost} of ${other.label}`;
    if (!says) continue;
    items.push({ scope, repo, kind, text: `In ${repoNameOf(repo)}, ${best.label} ${says}`, runs: rs.length });
  }
  return items.sort((a, b) => b.runs - a.runs);
}

const benchName = (tool: string, model: string): string | null => (tool === "friday" ? (model === "pro" ? "Friday Pro" : "Friday") : (ENGINE_MODEL_INFO[tool as EngineTool]?.find((m) => m.id === model)?.label ?? null));

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
