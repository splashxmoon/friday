import assert from "node:assert/strict";
import test from "node:test";
import { GOAL, MAX_GOAL_NUDGES, goalApplies, goalEvidence, goalNudge, goalRequest, parseVerdict } from "../src/goal.js";
import { apply, initialState } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const HUMAN = { id: "u1", name: "Arun", kind: "human" as const };
const AGENT = { id: "agent", name: "Claude Code", kind: "agent" as const };
let seq = 0;
const ev = (body: EventBody, actor: SessionEvent["actor"] = AGENT, lane?: string): SessionEvent => ({ seq: ++seq, ts: 1_700_000_000_000 + seq, actor, body, ...(lane ? { lane } : {}) }) as SessionEvent;

function session(): { events: SessionEvent[]; end: number } {
  seq = 0;
  const events: SessionEvent[] = [
    ev({ type: "session.created", title: "t", ownerId: "u1", ownerName: "Arun" } as EventBody, HUMAN),
    ev({ type: "goal.set", text: "the tests pass and a pull request is open", check: "npm test" } as EventBody, HUMAN),
    ev({ type: "instruction", text: "Fix the streak reset.", interrupt: false } as EventBody, HUMAN),
    ev({ type: "run.started" } as EventBody),
    ev({ type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) }] } as EventBody),
    ev({ type: "tool.result", callId: "c1", name: "run_command", output: "2 failing", isError: true } as EventBody),
    ev({ type: "agent.message", text: "Two tests still fail; I'll look at them next.", toolCalls: [] } as EventBody),
    ev({ type: "agent.diff", base: "abc", files: [{ path: "src/streak.ts", status: "modified", additions: 4, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }] } as EventBody),
    ev({ type: "run.ended", outcome: "done" } as EventBody),
  ];
  return { events, end: events.at(-1)!.seq };
}

test("Goal mode: the state carries the goal, counts the turns read and the nudges, and marks it met", () => {
  const { events, end } = session();
  let s = events.reduce(apply, initialState("s1"));
  assert.equal(s.goal?.text, "the tests pass and a pull request is open");
  assert.equal(s.goal?.check, "npm test");
  assert.equal(s.goal?.lane, "main");
  assert.equal(s.goal?.by.name, "Arun");
  assert.ok(goalApplies(s, "main", "done"));
  assert.ok(!goalApplies(s, "other", "done"));
  assert.ok(!goalApplies(s, "main", "error"));
  s = apply(s, ev({ type: "goal.checked", runSeq: end, met: false, why: "The tests failed.", nudge: true } as EventBody, GOAL));
  assert.equal(s.goal?.checks, 1);
  assert.equal(s.goal?.nudges, 1);
  assert.equal(s.goal?.last?.why, "The tests failed.");
  s = apply(s, ev({ type: "goal.checked", runSeq: end + 5, met: true, why: "npm test passed and gh pr create ran." } as EventBody, GOAL));
  assert.equal(s.goal?.met?.why, "npm test passed and gh pr create ran.");
  assert.ok(!goalApplies(s, "main", "done"));
  s = apply(s, ev({ type: "goal.cleared" } as EventBody, HUMAN));
  assert.equal(s.goal, null);
});

test("Goal mode: the evidence reads the turn's commands, tests and last words, and the judge is shown them with the goal", () => {
  const { events, end } = session();
  const s = events.reduce(apply, initialState("s1"));
  const e = goalEvidence(events, s, "main", end)!;
  assert.equal(e.tests, "fail");
  assert.deepEqual(e.commands, [{ command: "npm test", ok: false }]);
  assert.match(e.answer, /Two tests still fail/);
  assert.equal(e.files.length, 1);
  assert.equal(e.waiting, false);
  assert.equal(goalEvidence(events, s, "main", end - 1), null);
  const { system, prompt } = goalRequest(s.goal!, e);
  assert.match(system, /strict and literal/);
  assert.match(prompt, /The goal, as the person wrote it:\nthe tests pass/);
  assert.match(prompt, /proves it: `npm test`/);
  assert.match(prompt, /Test commands in this turn: ran and FAILED/);
  assert.match(prompt, /- FAILED: npm test/);
  assert.match(prompt, /- src\/streak\.ts \(modified/);
});

test("Goal mode: the verdict is read strictly, and the nudge says what's missing, the proof, and when it's the last ask", () => {
  assert.deepEqual(parseVerdict('Sure: {"met": false, "why": "Tests failed.", "next": "Fix the two failing tests."}'), { met: false, why: "Tests failed.", next: "Fix the two failing tests." });
  assert.equal(parseVerdict('{"met": "yes"}'), null);
  assert.equal(parseVerdict("I think so"), null);
  const goal = { text: "the tests pass", check: "npm test" };
  const n = goalNudge(goal, { met: false, why: "Tests failed.", next: "Fix them." }, 0);
  assert.match(n, /isn't met yet: the tests pass/);
  assert.match(n, /What's missing: Tests failed\. Next: Fix them\./);
  assert.match(n, /`npm test` succeeding/);
  assert.ok(!/last time/.test(n));
  assert.match(goalNudge(goal, { met: false, why: "x", next: "" }, MAX_GOAL_NUDGES - 1), /last time you'll be asked/);
});
