import assert from "node:assert/strict";
import { test } from "node:test";
import { shortDuration, shortTokens, usageReport } from "../src/usage-report.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const ev = (seq: number, ts: number, name: string, body: EventBody, lane?: string): SessionEvent => ({ seq, ts, actor: { id: name.toLowerCase(), name } as SessionEvent["actor"], body, ...(lane ? { lane } : {}) });
const say = (seq: number, ts: number, who: string, text: string, lane?: string) => ev(seq, ts, who, { type: "instruction", text, interrupt: false }, lane);
const start = (seq: number, ts: number, causedBy: number, lane?: string) => ev(seq, ts, "Friday", { type: "run.started", causedBy }, lane);
const step = (seq: number, ts: number, tokens: number, lane?: string) => ev(seq, ts, "Friday", { type: "agent.message", text: "x", toolCalls: [], tokens }, lane);
const end = (seq: number, ts: number, outcome: "done" | "waiting" | "error", lane?: string) => ev(seq, ts, "Friday", { type: "run.ended", outcome }, lane);
const names = (lane: string) => (lane === "main" ? "Friday Code" : "Reviewer");

test("tokens are split by agent and by whoever asked", () => {
  const events = [
    say(1, 0, "Alex", "fix the bug"),
    start(2, 1000, 1),
    step(3, 2000, 1200),
    step(4, 3000, 800),
    end(5, 5000, "done"),
    say(6, 6000, "Owen", "review it", "r1"),
    start(7, 6100, 6, "r1"),
    step(8, 7000, 500, "r1"),
    end(9, 9100, "done", "r1"),
  ];
  const r = usageReport(events, names);
  assert.equal(r.tokens, 2500);
  assert.equal(r.runs, 2);
  assert.deepEqual(r.byAgent.map((a) => [a.label, a.tokens]), [["Friday Code", 2000], ["Reviewer", 500]]);
  assert.deepEqual(r.byPerson.map((p) => [p.label, p.tokens, p.runs]), [["Alex", 2000, 1], ["Owen", 500, 1]]);
  assert.equal(r.recent[0]!.agent, "Reviewer");
  assert.equal(r.biggest?.tokens, 2000);
  assert.equal(r.recent.find((x) => x.by === "Alex")!.seconds, 4);
});

test("a run nobody asked for is automatic, and one still going is counted so far", () => {
  const events = [start(1, 0, 99), step(2, 500, 300)];
  const r = usageReport(events, names, null, 4000);
  assert.equal(r.byPerson[0]!.label, "Automatic runs");
  assert.equal(r.recent[0]!.outcome, "running");
  assert.equal(r.recent[0]!.seconds, 4);
  assert.equal(r.tokens, 300);
});

test("a run that never ended before the next began is closed at the next", () => {
  const events = [say(1, 0, "Alex", "a"), start(2, 0, 1), step(3, 10, 100), say(4, 20, "Alex", "b"), start(5, 3000, 4), step(6, 3100, 50), end(7, 4000, "done")];
  const r = usageReport(events, names);
  assert.equal(r.runs, 2);
  assert.equal(r.tokens, 150);
  assert.equal(r.recent[1]!.seconds, 3);
});

test("a session with no runs reports nothing rather than failing", () => {
  const r = usageReport([say(1, 0, "Alex", "hi")], names);
  assert.equal(r.tokens, 0);
  assert.equal(r.biggest, null);
  assert.deepEqual(r.byAgent, []);
});

test("numbers are shortened the way a person would say them", () => {
  assert.equal(shortTokens(950), "950");
  assert.equal(shortTokens(1240), "1.2k");
  assert.equal(shortTokens(48000), "48k");
  assert.equal(shortTokens(2_100_000), "2.1M");
  assert.equal(shortDuration(45), "45s");
  assert.equal(shortDuration(75), "1m 15s");
  assert.equal(shortDuration(3700), "1h 1m");
});

test("a run that was cut off is counted up to its last step, not to this moment", () => {
  const events = [say(1, 0, "Alex", "a"), start(2, 1000, 1), step(3, 61_000, 100)];
  const gone = usageReport(events, names, new Set(), 10_000_000);
  assert.equal(gone.recent[0]!.seconds, 60);
  assert.equal(gone.recent[0]!.outcome, "done");
  const going = usageReport(events, names, new Set(["main"]), 301_000);
  assert.equal(going.recent[0]!.seconds, 300);
  assert.equal(going.recent[0]!.outcome, "running");
});

test("an agent that reports no tokens is marked as not counted, so zero is not mistaken for free", () => {
  const events = [
    say(1, 0, "Alex", "a"), start(2, 0, 1), ev(3, 1000, "Friday", { type: "agent.message", text: "x", toolCalls: [] } as EventBody), end(4, 2000, "done"),
    say(5, 3000, "Alex", "b", "cli"), start(6, 3000, 5, "cli"), step(7, 4000, 250, "cli"), end(8, 5000, "done", "cli"),
  ];
  const r = usageReport(events, (l) => (l === "main" ? "Claude Code" : "Friday Code"), null);
  assert.deepEqual(r.byAgent.map((a) => [a.label, a.counted]), [["Friday Code", true], ["Claude Code", false]]);
});

test("each row knows when it last ran and whether it is going now", () => {
  const events = [say(1, 0, "Alex", "a"), start(2, 1000, 1), step(3, 2000, 10), end(4, 61_000, "done"), say(5, 70_000, "Alex", "b", "r"), start(6, 71_000, 5, "r"), step(7, 72_000, 5, "r")];
  const r = usageReport(events, names, new Set(["r"]), 200_000);
  const main = r.byAgent.find((a) => a.key === "main")!;
  const rev = r.byAgent.find((a) => a.key === "r")!;
  assert.equal(main.running, false);
  assert.equal(main.lastAt, 61_000);
  assert.equal(rev.running, true);
  assert.equal(rev.lastAt, 200_000, "while it is going, it last did something just now");
});
