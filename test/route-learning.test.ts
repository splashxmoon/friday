// What routing learns from how runs end (route-learning.ts): each workspace's outcomes move a model's benchmark estimate, the repo's
// own move it further, a run is graded by the evidence under its "done", what comes later revises the grade, and a failure for an
// account reason teaches nothing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "ioredis";
import { gradeOf, learnedSuccess, lessonOf, missedLast, PRIOR_RUNS, ranOn, RouteStats } from "../src/route-learning.js";
import { fitModels, pickFit, routeFriday } from "../src/routing.js";
import { MAIN_LANE, type EventBody, type SessionEvent } from "../src/types.js";

let seq = 0;
const ev = (body: EventBody, lane = MAIN_LANE, actor: SessionEvent["actor"] = { id: "x", name: "X", kind: "agent" }): SessionEvent => ({ seq: ++seq, ts: Date.now(), lane, actor, body }) as SessionEvent;
const HUMAN: SessionEvent["actor"] = { id: "u1", name: "Ada", kind: "human" };

test("a model's estimate moves from its benchmark figure as runs here come in, and further as runs on the repo do", () => {
  assert.equal(learnedSuccess(0.9), 0.9);
  assert.equal(learnedSuccess(0.9, { n: 10, ok: 10 }), (PRIOR_RUNS * 0.9 + 10) / (PRIOR_RUNS + 10));
  assert.ok(learnedSuccess(0.9, { n: 30, ok: 12 }) < 0.6, "many misses outweigh the benchmark");
  assert.equal(learnedSuccess(0.5, { n: 2, ok: -1 }), (PRIOR_RUNS * 0.5) / (PRIOR_RUNS + 2), "an undo can't take it below none");
  // The workspace's figure is the prior for the repo: ten runs' worth, which ten runs on the repo then meet halfway.
  assert.equal(learnedSuccess(0.8, { n: 10, ok: 2 }, { n: 10, ok: 10 }), 0.75);
  assert.equal(learnedSuccess(0.8, undefined, { n: 10, ok: 10 }), 0.9, "with nothing for the workspace, the benchmark is the repo's prior");
});

test("what a run ran on: a lane's model, a tool's default, Auto's pick or the session's model", () => {
  assert.deepEqual(ranOn({ type: "model.routed", model: "opus", tier: "heavy", why: "", shadow: true, tool: "claude", current: "" }), { tool: "claude", model: "opus" });
  assert.deepEqual(ranOn({ type: "model.routed", model: "opus", tier: "heavy", why: "", shadow: true, tool: "claude", current: "sonnet" }), { tool: "claude", model: "sonnet" });
  assert.deepEqual(ranOn({ type: "model.routed", model: "", tier: "light", why: "" }), { tool: "friday", model: "base" });
  assert.equal(ranOn({ type: "model.routed", model: "", tier: "light", why: "", shadow: true, current: "openai/gpt-5.5" }), null, "no figures, nothing to learn");
});

/** A run on a lane: the pick before it, its start, what it did, and its end. */
function run(lane: string, o: { tests?: "pass" | "fail" | "none"; outcome?: "done" | "error" | "waiting"; error?: string; checkpoint?: string } = {}) {
  const routed = ev({ type: "model.routed", model: "opus", tier: "heavy", why: "", shadow: true, tool: "claude", current: "" }, lane);
  const started = ev({ type: "run.started", causedBy: 1, ...(o.checkpoint ? { checkpoint: o.checkpoint } : {}) }, lane);
  const did: SessionEvent[] = [];
  if (o.tests && o.tests !== "none") {
    did.push(ev({ type: "agent.message", text: "Running the tests.", toolCalls: [{ id: "c1", name: "shell", arguments: JSON.stringify({ command: "npm test" }) }] }, lane));
    did.push(ev({ type: "tool.result", callId: "c1", name: "shell", output: o.tests === "pass" ? "12 passing" : "3 failing", isError: o.tests === "fail" }, lane));
  }
  const said = ev({ type: "agent.message", text: "Done.", toolCalls: [] }, lane);
  const ended = ev({ type: "run.ended", outcome: o.outcome ?? "done", ...(o.error ? { error: o.error } : {}) }, lane);
  return { events: [routed, started, ...did, said, ended], ended, said };
}

test("a run's end is graded by what it can show: tests passed, none ran, tests failed, or an error; an account failure teaches nothing", () => {
  const lane = "lane-a";
  const plain = run(lane);
  assert.deepEqual(lessonOf(plain.events, plain.ended), { key: "claude:opus:heavy", run: `${lane}:${plain.ended.seq}`, grade: 0.8 }, "done, with nothing checked");
  const passed = run(lane, { tests: "pass" });
  assert.deepEqual(lessonOf(passed.events, passed.ended), { key: "claude:opus:heavy", run: `${lane}:${passed.ended.seq}`, grade: 1 });
  const failed = run(lane, { tests: "fail" });
  assert.equal(lessonOf(failed.events, failed.ended)!.grade, 0.25, "it said done over a failing suite");
  assert.equal(gradeOf(failed.events, lane, failed.ended.seq), 0.25);
  const broke = run(lane, { outcome: "error", error: "The tests still fail." });
  assert.equal(lessonOf(broke.events, broke.ended)!.grade, 0);
  const spent = run(lane, { outcome: "error", error: "This workspace has used its allowance for this 5-hour window." });
  assert.equal(lessonOf(spent.events, spent.ended), null);
  const asked = run(lane, { outcome: "waiting" });
  assert.equal(lessonOf(asked.events, asked.ended), null, "stopped to ask: neither right nor wrong yet");
  assert.deepEqual(lessonOf(passed.events, passed.ended, "github.com/a/b"), { key: "claude:opus:heavy", run: `${lane}:${passed.ended.seq}`, grade: 1, repo: "github.com/a/b" }, "with the repo it was on");
});

test("what comes later revises a run's grade: an undo, a review's findings, a correction, a reaction", () => {
  const lane = "lane-b";
  const sha = "c".repeat(40);
  const r = run(lane, { tests: "pass", checkpoint: sha });
  const key = "claude:opus:heavy";
  const id = `${lane}:${r.ended.seq}`;
  const undone = ev({ type: "folder.restored", sha, undo: "d".repeat(40), restored: 3, removed: 0 }, lane);
  assert.deepEqual(lessonOf([...r.events, undone], undone), { key, run: id, grade: 0, replace: "set" });
  const reviewed = ev({ type: "review.done", runSeq: r.ended.seq, round: 1, findings: [{ severity: "high", title: "Drops the auth check", detail: "" }], sent: true }, lane);
  assert.deepEqual(lessonOf([...r.events, reviewed], reviewed), { key, run: id, grade: 0.5, replace: "mul" });
  const minor = ev({ type: "review.done", runSeq: r.ended.seq, round: 1, findings: [{ severity: "low", title: "Nit", detail: "" }], sent: false }, lane);
  assert.equal(lessonOf([...r.events, minor], minor), null, "nothing serious found: the grade stands");
  const corrected = ev({ type: "instruction", text: "It still fails with the same error", interrupt: false }, lane, HUMAN);
  assert.deepEqual(lessonOf([...r.events, corrected], corrected), { key, run: id, grade: 0.25, replace: "min" });
  const unrelated = ev({ type: "instruction", text: "Now add the coupon test", interrupt: false }, lane, HUMAN);
  assert.equal(lessonOf([...r.events, unrelated], unrelated), null);
  const late = ev({ type: "instruction", text: "still broken", interrupt: false }, lane, HUMAN);
  assert.equal(lessonOf([...r.events, unrelated, late], late), null, "a correction of something else said since, not of that run");
  const up = ev({ type: "message.reacted", seq: r.said.seq, up: true }, lane, HUMAN);
  assert.deepEqual(lessonOf([...r.events, up], up), { key, run: id, grade: 1, replace: "max" });
  const down = ev({ type: "message.reacted", seq: r.said.seq, up: false, reason: "wrong file" }, lane, HUMAN);
  assert.deepEqual(lessonOf([...r.events, down], down), { key, run: id, grade: 0.5, replace: "min" });
  const gone = ev({ type: "message.reacted", seq: r.said.seq, up: null }, lane, HUMAN);
  assert.equal(lessonOf([...r.events, gone], gone), null);
});

test("whether the last run on a lane missed, as the next pick should know", () => {
  const lane = "lane-c";
  assert.equal(missedLast([], lane), false);
  assert.equal(missedLast(run(lane, { tests: "pass" }).events, lane), false);
  assert.equal(missedLast(run(lane, { tests: "fail" }).events, lane), true, "done over failing tests");
  assert.equal(missedLast(run(lane, { outcome: "error", error: "Threw halfway." }).events, lane), true);
  assert.equal(missedLast(run(lane, { outcome: "error", error: "Codex isn't logged in." }).events, lane), false, "not the model's fault");
  assert.equal(missedLast(run(lane).events, lane, "That's not it, the cart still shows zero"), true, "the message now being sent says so");
  const sha = "e".repeat(40);
  const r = run(lane, { tests: "pass", checkpoint: sha });
  assert.equal(missedLast([...r.events, ev({ type: "folder.restored", sha, undo: "f".repeat(40), restored: 1, removed: 0 }, lane)], lane), true, "undone since");
});

test("outcomes are kept per workspace and per repo, a later signal revises the run it is about, and enough misses change the pick", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { lazyConnect: true, maxRetriesPerRequest: 1 });
  const prefix = `test-route-${randomUUID().slice(0, 8)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });
  const stats = new RouteStats(redis, prefix);
  const key = "claude:haiku:light";
  for (let i = 0; i < 12; i++) await stats.learn("ws-1", { key, run: `main:${i}`, grade: i < 4 ? 1 : 0, repo: "github.com/a/b" }, "s1");
  // An undo of a run that counted in full, and a review that halves another.
  await stats.learn("ws-1", { key, run: "main:0", grade: 0, replace: "set", repo: "github.com/a/b" }, "s1");
  await stats.learn("ws-1", { key, run: "main:1", grade: 0.5, replace: "mul", repo: "github.com/a/b" }, "s1");
  // A thumbs-up on a run already at 1 changes nothing; a correction of a run nobody kept a grade for takes it from 1 down.
  await stats.learn("ws-1", { key, run: "main:2", grade: 1, replace: "max", repo: "github.com/a/b" }, "s1");
  await stats.learn("ws-1", { key, run: "main:99", grade: 0.25, replace: "min", repo: "github.com/a/b" }, "s1");
  const learned = await stats.get("ws-1");
  assert.deepEqual(learned[key], { n: 12, ok: 1.75 });
  assert.deepEqual(learned[`${key}@github.com/a/b`], { n: 12, ok: 1.75 }, "the repo's own count, the same");
  assert.deepEqual(await stats.get("ws-2"), {}, "another workspace starts from the benchmarks");
  // Haiku is light work's pick on the benchmarks; under two right in twelve here and Sonnet takes it.
  assert.equal(pickFit(fitModels("claude", "light"), "light")!.model, "haiku");
  const fit = fitModels("claude", "light", [], learned);
  assert.equal(fit.find((f) => f.model === "haiku")!.runs, 12);
  assert.equal(pickFit(fit, "light")!.model, "sonnet");
  // On another repo of the workspace, the workspace's figure is the prior and the repo has nothing yet: still Sonnet.
  const elsewhere = fitModels("claude", "light", [], learned, { repo: "github.com/a/c" });
  assert.deepEqual([elsewhere.find((f) => f.model === "haiku")!.runs, pickFit(elsewhere, "light")!.model], [0, "sonnet"]);
});
