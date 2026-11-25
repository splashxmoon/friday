/**
 * Where a check of a finished run stands (spec 13; check-badge.tsx draws it under the reply): read from the proof events after the run
 * ended and before the lane's next run began, so every place that sums up a finished run says what the reply's badge says, the side
 * panel's agent row and the thread card's proof among them (Arun, 2026-11-24: "Go all out and fix these problems").
 */
import { MAIN_LANE, type SessionEvent } from "./types.js";

type ProofEv = Extract<SessionEvent["body"], { type: "proof.tests" | "proof.status" | "proof.clip" }>;
type TestsBody = Extract<SessionEvent["body"], { type: "proof.tests" }>;

/** Where a check of one run stands, from the proof events after it ended and before the lane's next run began. */
export type CheckState =
  | { phase: "none" }
  | { phase: "checking"; command?: string }
  | { phase: "passed"; tests?: number; command: string }
  | { phase: "failed"; failing: number; first?: string; command: string; tail: string }
  | { phase: "couldnt"; why: string }
  | { phase: "clip" };

export function checkStateOf(events: readonly SessionEvent[], lane: string, endSeq: number): CheckState {
  const on = (e: SessionEvent) => (e.lane ?? MAIN_LANE) === lane;
  const next = events.find((e) => e.seq > endSeq && on(e) && e.body.type === "run.started")?.seq ?? Number.MAX_SAFE_INTEGER;
  const mine = events.filter((e) => e.seq > endSeq && e.seq < next && on(e) && (e.body.type === "proof.tests" || e.body.type === "proof.status" || e.body.type === "proof.clip"));
  const tests = mine.findLast((e) => e.body.type === "proof.tests")?.body as TestsBody | undefined;
  if (tests?.runs.length) {
    const bad = tests.runs.filter((r) => !r.ok);
    if (!bad.length) {
      const counted = tests.runs.filter((r) => r.passed !== undefined);
      return { phase: "passed", ...(counted.length ? { tests: counted.reduce((n, r) => n + (r.passed ?? 0), 0) } : {}), command: tests.runs.map((r) => r.command).join("\n") };
    }
    const b = bad[0]!;
    return { phase: "failed", failing: bad.reduce((n, r) => n + (r.failed ?? (r.failing?.length || 1)), 0), ...(b.failing?.[0] ? { first: b.failing[0] } : {}), command: b.command, tail: b.tail };
  }
  const last = mine.at(-1)?.body as ProofEv | undefined;
  if (!last) return { phase: "none" };
  if (last.type === "proof.clip") return { phase: "clip" };
  if (last.type === "proof.status" && last.stage === "failed") return { phase: "couldnt", why: last.why ?? "Friday couldn't run a check here." };
  return { phase: "checking", ...(last.type === "proof.status" && last.command ? { command: last.command } : {}) };
}

/** A check's words as the reply's badge says them ("Checked · 3 tests pass", "Check failed · 2 tests", "Checking…"); null when none was asked. */
export function checkWords(st: CheckState): { text: string; tone: "pass" | "fail" | "none" } | null {
  switch (st.phase) {
    case "checking":
      return { text: "Checking…", tone: "none" };
    case "passed":
      return { text: `Checked · ${st.tests !== undefined ? `${st.tests} ${st.tests === 1 ? "test passes" : "tests pass"}` : "tests pass"}`, tone: "pass" };
    case "failed":
      return { text: `Check failed${st.failing > 1 ? ` · ${st.failing} tests` : ""}`, tone: "fail" };
    case "couldnt":
      return { text: "Done · couldn't check", tone: "none" };
    case "clip":
      return { text: "Done · shown in a clip", tone: "none" };
    default:
      return null;
  }
}

/** What Fix it asks the agent: the first failing check, the end of what it printed, and to fix that, honestly. */
export function fixFirstText(s: Extract<CheckState, { phase: "failed" }>): string {
  const lines = s.tail.split(/\r?\n/);
  if (lines[0]?.trim() === `$ ${s.command}`) lines.shift();
  const tail = lines.slice(-40).join("\n").trim().slice(-3000);
  return `The check failed: \`${s.command}\`${s.first ? `, first at "${s.first}"` : ""}.\n\n\`\`\`\n${tail}\n\`\`\`\n\nFix the first failure, run the check again until it passes, and say where it stands. Don't skip or disable anything to get there.`;
}
