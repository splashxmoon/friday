import { receiptOf } from "./receipt.js";
import type { SessionState } from "./session/projection.js";
import { MAIN_LANE, type DiffFile, type SessionEvent } from "./types.js";

/**
 * Goal mode (Arun, 2026-10-25, tier 2: "keep working across turns until a stated done condition is met").
 *
 * A person says when the work is done ("the tests pass and the PR is open"), and from then on every finished turn on that
 * agent is read against it: what the agent said, what it changed, what its test commands did. Not met, and the agent is
 * told so and told to carry on, up to a few times; met, and the goal is marked so and everyone is told. The judge is a
 * model, since a done condition is said in words; a check command, when given, is what the agent is told to run to prove it.
 * The pure parts live here: the evidence read from the log, the judge's request, its verdict, and the nudge.
 */

/** The system actor the checks and nudges come from: not a member, not the agent. */
export const GOAL = { id: "goal", name: "Goal", kind: "system" as const };

/** Turns the goal is pressed for before it stops asking and leaves it to the person. */
export const MAX_GOAL_NUDGES = 8;

export interface GoalState {
  text: string;
  /** A command whose success is the proof, when the person gave one. */
  check?: string;
  lane: string;
  by: { id: string; name: string };
  seq: number;
  /** Turns read against the goal so far, and how many of them ended in a nudge. */
  checks: number;
  nudges: number;
  /** The latest reading. */
  last?: { met: boolean; why: string; seq: number };
  /** Set once the goal was met. */
  met?: { seq: number; why: string };
}

export interface GoalEvidence {
  /** What the agent said at the end of the turn. */
  answer: string;
  files: DiffFile[];
  tests: "pass" | "fail" | "none";
  /** The commands it ran, newest last, with whether each worked. */
  commands: { command: string; ok: boolean }[];
  /** Whether it asked a person something and stopped. */
  waiting: boolean;
}

/** The turn that ended at `endSeq` on this lane, as the judge needs it; null when there is no such turn. */
export function goalEvidence(events: SessionEvent[], state: SessionState, lane: string, endSeq: number): GoalEvidence | null {
  const mine = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
  const endAt = mine.findIndex((e) => e.seq === endSeq && e.body.type === "run.ended");
  if (endAt < 0) return null;
  const startAt = mine.slice(0, endAt).findLastIndex((e) => e.body.type === "run.started");
  const run = mine.slice(Math.max(0, startAt), endAt + 1);
  const said = run.findLast((e) => e.body.type === "agent.message" && e.body.text.trim());
  const diff = run.findLast((e) => e.body.type === "agent.diff");
  const files = diff?.body.type === "agent.diff" ? diff.body.files : [];
  const calls = run.flatMap((e) => (e.body.type === "agent.message" ? e.body.toolCalls : []));
  const results = new Map<string, boolean>();
  for (const e of run) if (e.body.type === "tool.result") results.set(e.body.callId, e.body.isError);
  const receipt = receiptOf({ calls, failed: (id) => (results.has(id) ? results.get(id)! : null), files });
  return {
    answer: said?.body.type === "agent.message" ? said.body.text.trim() : "",
    files,
    tests: receipt.tests,
    commands: receipt.commands.map((c) => ({ command: c.command, ok: c.ok })),
    waiting: !!(state.asks[lane] || state.openQuestions[lane] || state.approvals[lane]),
  };
}

/** What the judge is told and shown. */
export function goalRequest(goal: Pick<GoalState, "text" | "check">, ev: GoalEvidence): { system: string; prompt: string } {
  const system = `You judge whether a coding agent's work has reached the goal a person set, from one finished turn: what the agent said, the files it changed, and the commands it ran. Be strict and literal about the goal as written: "the tests pass" is met only by a test command that ran and passed in this turn, not by the agent saying so; "a PR is open" is met only by a command or a message that shows one was opened. Where the goal cannot be seen from this evidence, it is not met, and say what would show it.

Answer with JSON only, nothing before or after, in this shape:
{"met": false, "why": "One or two sentences on what is and isn't there.", "next": "The one next thing the agent should do, in a sentence; empty when met."}`;
  const commands = ev.commands.length ? ev.commands.slice(-20).map((c) => `- ${c.ok ? "ok" : "FAILED"}: ${c.command.slice(0, 200)}`).join("\n") : "(none)";
  const files = ev.files.length ? ev.files.slice(0, 40).map((f) => `- ${f.path} (${f.status}, +${f.additions} −${f.deletions})`).join("\n") : "(none)";
  const prompt = [
    `The goal, as the person wrote it:\n${goal.text.slice(0, 2000)}`,
    goal.check ? `The command whose success proves it: \`${goal.check}\`` : "",
    `Test commands in this turn: ${ev.tests === "pass" ? "ran and passed" : ev.tests === "fail" ? "ran and FAILED" : "none ran"}.`,
    `Commands the agent ran:\n${commands}`,
    `Files it changed:\n${files}`,
    `What it said at the end:\n${ev.answer ? ev.answer.slice(0, 6000) : "(nothing)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt };
}

export interface Verdict {
  met: boolean;
  why: string;
  next: string;
}

/** The judge's answer as a verdict; null when it isn't the shape asked for, which is never taken as met. */
export function parseVerdict(text: string): Verdict | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { met?: unknown; why?: unknown; next?: unknown };
    if (typeof o.met !== "boolean") return null;
    return { met: o.met, why: String(o.why ?? "").slice(0, 600), next: String(o.next ?? "").slice(0, 600) };
  } catch {
    return null;
  }
}

/** What the agent is told when the goal isn't met yet. */
export function goalNudge(goal: Pick<GoalState, "text" | "check">, v: Verdict, nudge: number): string {
  return [
    `The goal for this work isn't met yet: ${goal.text.trim()}`,
    `What's missing: ${v.why}${v.next ? ` Next: ${v.next}` : ""}`,
    goal.check ? `The proof is \`${goal.check}\` succeeding: run it, and don't say the goal is met until it does.` : "When you believe it is met, say so and say how you checked.",
    `Carry on until it is met${nudge >= MAX_GOAL_NUDGES - 1 ? "; this is the last time you'll be asked, so if it can't be, say exactly why" : ""}.`,
  ].join("\n\n");
}

/** Whether a finished turn should be read against the goal at all. */
export function goalApplies(state: SessionState, lane: string, outcome: string): boolean {
  const g = state.goal;
  return !!g && g.lane === lane && !g.met && outcome === "done";
}
