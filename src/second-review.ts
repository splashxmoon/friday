import type { LLM } from "./agent/llm.js";
import { MAIN_LANE, type DiffFile, type ReviewFinding, type SessionEvent } from "./types.js";

/**
 * A second agent reads every change before a person does.
 *
 * When a run ends having changed code, a reviewer looks at the change against what was asked: bugs, broken behaviour,
 * security holes, edge cases the change should handle. Style and taste are left alone. What it finds that matters goes
 * back to the agent that made the change, once; the fix is read again, and anything still wrong is left on the card for
 * the person. These are the pure parts: which run to read, what to ask, how to read the answer, and what to tell the agent.
 */

/** Who the review is from, in the log. */
export const REVIEWER = { id: "reviewer", name: "Reviewer", kind: "system" as const };
/** How the reviewer's findings start when they go back to the agent. */
export const REVIEW_TAG = "[second review]";

/** The most diff the reviewer is shown, across all files. */
const MAX_DIFF = 40_000;
const MAX_FINDINGS = 6;

export interface ReviewPlan {
  /** The `run.ended` this review is of. */
  endSeq: number;
  /** 1 for the agent's own change, 2 for its fix of what the reviewer found. */
  round: number;
  /** What the person asked for, so the change can be read against it. */
  ask: string;
  files: DiffFile[];
  /** Whether what it finds may go back to the agent: only the first round, and only while nobody has spoken since. */
  send: boolean;
}

/**
 * The run to review in this lane, if there is one: the latest, if it finished, changed files, and has not been reviewed.
 * A run that was the agent fixing the reviewer's findings is round two; nothing past that is reviewed.
 */
export function reviewPlan(events: SessionEvent[], lane: string): ReviewPlan | null {
  const mine = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
  const endAt = mine.findLastIndex((e) => e.body.type === "run.ended");
  if (endAt < 0) return null;
  const end = mine[endAt]!;
  if (end.body.type !== "run.ended" || end.body.outcome !== "done") return null;
  if (events.some((e) => (e.body.type === "review.started" || e.body.type === "review.done") && e.body.runSeq === end.seq)) return null;
  const startAt = mine.slice(0, endAt).findLastIndex((e) => e.body.type === "run.started");
  if (startAt < 0) return null;
  const diff = mine.slice(startAt, endAt + 1).findLast((e) => e.body.type === "agent.diff");
  const files = diff?.body.type === "agent.diff" ? diff.body.files.filter((f) => f.patch.trim()) : [];
  if (!files.length) return null;

  const before = mine.slice(0, startAt);
  const asked = before.findLast((e) => e.body.type === "instruction");
  const round = asked?.actor.id === REVIEWER.id ? 2 : 1;
  if (round === 2) {
    // A fix of a fix is not reviewed again: two rounds is where a person takes over.
    const earlier = events.filter((e) => e.body.type === "review.done" && (e.lane ?? MAIN_LANE) === lane && e.seq < (asked?.seq ?? 0));
    if (earlier.at(-1)?.body.type === "review.done" && (earlier.at(-1)!.body as { round: number }).round >= 2) return null;
  }
  const human = before.findLast((e) => e.body.type === "instruction" && e.actor.kind === "human" && !e.body.text.startsWith("[session]"));
  const ask = human?.body.type === "instruction" ? human.body.text : "";
  const spokeSince = events.some((e) => e.seq > end.seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && e.actor.kind === "human");
  return { endSeq: end.seq, round, ask, files, send: round === 1 && !spokeSince };
}

/** What the reviewer is told and shown. `who` says whose change it is: by default an agent's, before any person sees it. */
export function reviewRequest(plan: ReviewPlan, who = "You review a change another coding agent just made, before any person sees it."): { system: string; prompt: string } {
  const system = `${who}

Find real problems only: bugs, broken behaviour, security holes, lost data, edge cases the change should handle and does not, and anything that does not do what the person asked. Do not comment on style, naming, formatting or matters of taste, and do not suggest refactors. Do not report something you are unsure of as a problem. If the change is sound, say so with an empty list: that is a good answer.

Severity: "high" means it will break or is unsafe; "medium" means it is likely wrong in a case that matters; "low" means worth knowing but not worth another round of work.

Answer with JSON only, nothing before or after it, in this shape:
{"findings":[{"severity":"high","path":"src/file.ts","line":12,"title":"Short name of the problem","detail":"What is wrong, in one or two sentences, and what would fix it."}]}

At most ${MAX_FINDINGS} findings, the most serious first.`;
  let budget = MAX_DIFF;
  const parts: string[] = [];
  for (const f of plan.files) {
    if (budget <= 0) {
      parts.push(`(${plan.files.length - parts.length} more file${plan.files.length - parts.length === 1 ? "" : "s"} not shown)`);
      break;
    }
    const patch = f.patch.length > budget ? `${f.patch.slice(0, budget)}\n… (cut short)` : f.patch;
    budget -= patch.length;
    parts.push(`--- ${f.path} (${f.status})\n${patch}${f.truncated ? "\n… (cut short)" : ""}`);
  }
  const prompt = `${plan.ask ? `What the person asked for:\n${plan.ask.slice(0, 4000)}\n\n` : ""}${plan.round === 2 ? "This is the agent's fix for problems an earlier review found. Check the fix, and anything it broke.\n\n" : ""}The change, as a unified diff:\n\n${parts.join("\n\n")}`;
  return { system, prompt };
}

const SEVERITIES = new Set(["high", "medium", "low"]);

/** The reviewer's answer as findings. Anything that is not the shape asked for is no finding at all, never a guess. */
export function parseFindings(text: string): ReviewFinding[] {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(from, to + 1));
  } catch {
    return [];
  }
  const list = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) return [];
  const out: ReviewFinding[] = [];
  for (const f of list as Record<string, unknown>[]) {
    if (!f || typeof f !== "object") continue;
    const severity = String(f.severity ?? "").toLowerCase();
    const title = typeof f.title === "string" ? f.title.trim().slice(0, 140) : "";
    if (!SEVERITIES.has(severity) || !title) continue;
    const detail = typeof f.detail === "string" ? f.detail.trim().slice(0, 700) : "";
    const path = typeof f.path === "string" && f.path.trim() ? f.path.trim().slice(0, 200) : undefined;
    const line = typeof f.line === "number" && Number.isFinite(f.line) && f.line > 0 ? Math.floor(f.line) : undefined;
    out.push({ severity: severity as ReviewFinding["severity"], title, detail, ...(path ? { path } : {}), ...(line ? { line } : {}) });
    if (out.length >= MAX_FINDINGS) break;
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The findings worth another round of work. */
export const blocking = (findings: ReviewFinding[]) => findings.filter((f) => f.severity !== "low");

/** What the agent is told: each problem where it is, and what is asked of it. */
export function findingsText(findings: ReviewFinding[]): string {
  const n = findings.length;
  const lines = findings.map((f) => `- [${f.severity}] ${f.path ? `${f.path}${f.line ? `:${f.line}` : ""}: ` : ""}${f.title}.${f.detail ? ` ${f.detail}` : ""}`);
  return `${REVIEW_TAG} A second agent read your change before anyone else sees it and found ${n} problem${n === 1 ? "" : "s"}:\n${lines.join("\n")}\n\nFix each one, or say plainly why it is not a problem. Change nothing else.`;
}

/** One review: ask the model, read its answer. */
export async function reviewChange(llm: LLM, plan: ReviewPlan, opts: { model?: string; signal?: AbortSignal } = {}): Promise<ReviewFinding[]> {
  const { system, prompt } = reviewRequest(plan);
  const r = await llm.complete({
    system,
    messages: [{ role: "user", content: prompt }] as never,
    tools: [],
    signal: opts.signal ?? AbortSignal.timeout(120_000),
    ...(opts.model ? { model: opts.model } : {}),
  });
  return parseFindings(r.text);
}
