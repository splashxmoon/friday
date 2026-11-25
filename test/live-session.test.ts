// Everything at work shown live (spec 13, Wave 3 E; Arun, 2026-11-20: "everything needs to feel like a working clock"): a working
// row's clock and step, and the "Done · unverified" badge's check read from the session's own events, so it stands after a reload.
import assert from "node:assert/strict";
import test from "node:test";
import { runClock, workingStep } from "../src/step-words.js";
import { checkStateOf, fixFirstText } from "../src/client/check-badge.js";
import type { SessionEvent } from "../src/types.js";

test("a run's clock counts seconds, then minutes and seconds, then hours and minutes", () => {
  assert.equal(runClock(-50), "0s");
  assert.equal(runClock(999), "0s");
  assert.equal(runClock(6_400), "6s");
  assert.equal(runClock(134_000), "2m 14s");
  assert.equal(runClock(3_900_000), "1h 5m");
});

test("a working row's step is the first working agent's, in its few words; none before it takes one", () => {
  assert.equal(workingStep(undefined), null);
  assert.equal(workingStep([{ state: "done", doing: { name: "edit", target: "a.ts" } }]), null, "not at work");
  assert.equal(workingStep([{ state: "working" }]), "Getting started", "no step yet: where it is, as the side panel says it");
  assert.equal(workingStep([{ state: "idle" }, { state: "working", doing: { name: "edit", target: "src/client/Sidebar.tsx" } }]), "Editing Sidebar.tsx");
  assert.equal(workingStep([{ state: "working", doing: { name: "shell", target: "npm test" } }]), "Running npm test");
});

let seq = 0;
const ev = (body: Record<string, unknown>, lane?: string): SessionEvent => ({ seq: ++seq, ts: seq * 1000, actor: { kind: "system", id: "friday", name: "Friday" }, body, ...(lane ? { lane } : {}) }) as unknown as SessionEvent;
const tests = (runs: Record<string, unknown>[], lane?: string) => ev({ type: "proof.tests", run: 1, by: "friday", runs }, lane);
const status = (stage: string, extra: Record<string, unknown> = {}, lane?: string) => ev({ type: "proof.status", stage, tests: true, asked: true, ...extra }, lane);

test("the check of a run: nothing yet, checking, passed with its count, failed with the first failure", () => {
  seq = 0;
  const end = ev({ type: "run.ended", outcome: "done" });
  assert.deepEqual(checkStateOf([end], "main", end.seq), { phase: "none" });
  const testing = status("testing", { command: "npm test" });
  assert.deepEqual(checkStateOf([end, testing], "main", end.seq), { phase: "checking", command: "npm test" });
  const passed = tests([{ command: "npm test", ok: true, passed: 12, tail: "ℹ pass 12" }]);
  assert.deepEqual(checkStateOf([end, testing, passed], "main", end.seq), { phase: "passed", tests: 12, command: "npm test" });
  const failed = tests([{ command: "npm test", ok: false, passed: 2, failed: 1, failing: ["cart total rounds to cents"], tail: "$ npm test\n✖ cart total rounds to cents\nℹ fail 1" }]);
  const st = checkStateOf([end, testing, failed], "main", end.seq);
  assert.equal(st.phase, "failed");
  assert.equal(st.phase === "failed" && st.first, "cart total rounds to cents");
  const text = fixFirstText(st as Extract<typeof st, { phase: "failed" }>);
  assert.match(text, /^The check failed: `npm test`, first at "cart total rounds to cents"\./);
  assert.ok(!text.includes("$ npm test\n✖"), "the command line it printed first isn't said twice");
  assert.match(text, /Fix the first failure/);
});

test("the check of a run: no test command, a clip instead, and only its own lane up to the lane's next run", () => {
  seq = 0;
  const end = ev({ type: "run.ended", outcome: "done" });
  assert.deepEqual(checkStateOf([end, status("failed", { why: "No test command." })], "main", end.seq), { phase: "couldnt", why: "No test command." });
  assert.deepEqual(checkStateOf([end, ev({ type: "proof.clip", page: "/", file: "a.webm", durationMs: 1, by: "check" })], "main", end.seq), { phase: "clip" });
  // Another lane's proof isn't this one's.
  assert.deepEqual(checkStateOf([end, tests([{ command: "npm test", ok: true, tail: "" }], "rev")], "main", end.seq), { phase: "none" });
  // A later run's proof isn't this one's either.
  const next = ev({ type: "run.started", causedBy: 1 });
  assert.deepEqual(checkStateOf([end, next, tests([{ command: "npm test", ok: true, tail: "" }])], "main", end.seq), { phase: "none" });
  // Tests with no counts printed: passed, without a number.
  assert.deepEqual(checkStateOf([end, tests([{ command: "make check", ok: true, tail: "ok" }])], "main", end.seq), { phase: "passed", command: "make check" });
});
