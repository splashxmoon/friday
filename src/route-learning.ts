import type { Redis } from "ioredis";
import { BENCH_ASOF, benchFor } from "./model-bench.js";

/** Friday Pro's model id: the hosted Friday's; the open-source edition has no Friday models, so nothing is learnt for them. */
let FRIDAY_PRO = "\u0000none";
import { commandFailed, receiptOf, type Receipt } from "./receipt.js";
import { tookCheckpoint } from "./rewind.js";
import { MAIN_LANE, type DiffFile, type EventBody, type SessionEvent, type ToolCall } from "./types.js";

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
export type Learned = Record<string, { n: number; ok: number }>;

/** How many runs the level above is worth: the benchmark to a workspace, the workspace to one of its repos. */
export const PRIOR_RUNS = 10;

/** A success rate from its benchmark estimate, the runs seen in the workspace, and the runs seen on the repo. */
export function learnedSuccess(prior: number, seen?: { n: number; ok: number }, local?: { n: number; ok: number }): number {
  const shrink = (p: number, s?: { n: number; ok: number }) => (!s?.n ? p : (PRIOR_RUNS * p + Math.max(0, Math.min(s.n, s.ok))) / (PRIOR_RUNS + s.n));
  return shrink(shrink(prior, seen), local);
}

/** What each coding tool runs with no model picked: Claude Code's default is Opus on every plan, Codex's its recommended model. */
const TOOL_DEFAULT: Record<string, string> = { claude: "opus", codex: "gpt-6.1-sol" };

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
const NOT_THE_MODEL = /allowance|team pro|on team|plan|sign(ed)? in|log(ged)? in|logged out|authenticat|credits|quota|rate limit|disconnected|lost its connection|reconnects/i;

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

/**
 * What an event teaches routing, if anything: a run's end and its grade; or a revision of a run's grade, from an undo, a second
 * review's findings, a correction in the next message, or a reaction to what the run said. Null when there is nothing to learn.
 */
export function lessonOf(events: SessionEvent[], ev: Pick<SessionEvent, "seq" | "lane" | "body" | "actor">, repo?: string): Lesson | null {
  const b = ev.body;
  const withRepo = (l: Lesson): Lesson => (repo ? { ...l, repo } : l);
  if (b.type === "run.ended") {
    if (b.outcome === "error" && NOT_THE_MODEL.test(b.error ?? "")) return null;
    // Stopped to ask a person: neither right nor wrong yet.
    if (b.outcome === "waiting") return null;
    const r = runOf(events, ev);
    if (!r) return null;
    return withRepo({ key: r.key, run: r.run, grade: b.outcome === "error" ? 0 : gradeOf(events, r.lane, ev.seq) });
  }
  if (b.type === "folder.restored") {
    const ended = undone(events, ev);
    const r = ended && runOf(events, ended);
    return r ? withRepo({ key: r.key, run: r.run, grade: 0, replace: "set" }) : null;
  }
  if (b.type === "review.done") {
    const ended = events.find((e) => e.seq === b.runSeq && e.body.type === "run.ended");
    const r = ended && runOf(events, ended);
    if (!r) return null;
    const worst = b.findings.some((f) => f.severity === "high") ? 0.5 : b.findings.some((f) => f.severity === "medium") ? 0.75 : null;
    return worst === null ? null : withRepo({ key: r.key, run: r.run, grade: worst, replace: "mul" });
  }
  if (b.type === "message.reacted") {
    if (b.up === null) return null;
    const said = events.find((e) => e.seq === b.seq && e.body.type === "agent.message");
    if (!said) return null;
    const lane = said.lane ?? MAIN_LANE;
    const ended = events.find((e) => e.seq > said.seq && onLane(e, lane) && e.body.type === "run.ended");
    const r = ended && runOf(events, ended);
    return r ? withRepo({ key: r.key, run: r.run, grade: b.up ? 1 : 0.5, replace: b.up ? "max" : "min" }) : null;
  }
  if (b.type === "instruction") {
    // A person, in their own words, saying the last run missed; not a hand-off, a message from another session, or an answer.
    if (ev.actor.kind !== "human" || b.handoff || b.peer || b.approval || !CORRECTION.test(b.text)) return null;
    const lane = ev.lane ?? MAIN_LANE;
    const prev = events.findLast((e) => e.seq < ev.seq && onLane(e, lane) && (e.body.type === "run.ended" || (e.body.type === "instruction" && e.actor.kind === "human")));
    if (!prev || prev.body.type !== "run.ended" || prev.body.outcome !== "done") return null;
    const r = runOf(events, prev);
    return r ? withRepo({ key: r.key, run: r.run, grade: 0.25, replace: "min" }) : null;
  }
  return null;
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
