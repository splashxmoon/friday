import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { MAX_CONNECTIONS_PER_RUN, type Workflow, type WorkflowStep } from "../src/team-workflow-model.js";
import type { TeammateView } from "../src/teammates.js";

process.env.FRIDAY_MINE = "1";
process.env.FRIDAY_TEAMMATES_DRY = "1";

async function harness(t: TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "friday-connections-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => { await app.close(); await kv.close(); await rm(home, { recursive: true, force: true }); });
  const call = async (p: string, body?: unknown) => {
    const r = await fetch(`${app.url}${p}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(r.ok, `${p}: ${await r.clone().text()}`);
    return r.json();
  };
  let sid = "";
  let mates: TeammateView[] = [];
  for (const name of ["Dev", "QA", "Fixer"]) {
    const team = await call("/api/teammates", { name, tool: "claude", folder: path.join(home, name) });
    sid = team.sid; mates = team.teammates;
  }
  const engine = app.workflows.engine()!;
  const step = (id: string, col: number, who = "Dev", extra: Partial<WorkflowStep> = {}): WorkflowStep => ({ id, col, mate: mates.find(m => m.name === who)!.id, does: id, owns: [], ...extra });
  const save = async (steps: WorkflowStep[]): Promise<Workflow> => (await call("/api/workflows", { name: "Branch routing", steps, outcomes: { brief: false, notify: false, pr: false, then: "" } })).workflow;
  const board = async () => (await app.store.state(sid)).board!;
  const complete = async (review = "PASS", blocked = false) => {
    const current = await board();
    for (const task of current.tasks) {
      const lane = mates.find(m => m.name === (task.next || task.name))?.lane ?? mates[0]!.lane;
      const actor = { id: "test", name: task.next || task.name || "Dev", kind: "system" as const };
      await app.store.append(sid, actor, { type: "board.finished", id: task.id, lane, name: actor.name, status: blocked ? "blocked" : "done", report: task.noReview ? review : `Done: ${task.title}` }, { lane });
      if (!blocked && !task.noReview) await app.store.append(sid, actor, { type: "board.reviewed", id: task.id, lane, name: actor.name, ok: true, note: "Checked" }, { lane });
    }
    await engine.sync(sid);
  };
  return { app, engine, sid, step, save, board, complete, call, kv };
}

test("a failed review visits its dedicated fixer path, rejoins Implement and finishes only the passing path", async t => {
  const h = await harness(t);
  const w = await h.save([
    h.step("plan", 0), h.step("implement", 1),
    h.step("review", 2, "QA", { kind: "check", next: "finalize", otherwise: "fixes" }),
    h.step("finalize", 3, "Dev", { next: "$finish" }),
    h.step("fixes", 4, "Fixer", { next: "implement", does: "Prepare a precise list of fixes" }),
  ]);
  assert.equal((await h.call(`/api/workflows`)).workflows[0].steps[2].otherwise, "fixes");
  const run = await h.engine.start(w, "test");
  await h.complete("FAIL: missing regression test");
  assert.deepEqual((await h.board()).tasks.map(t => t.next || t.name), ["Fixer"]);
  assert.match((await h.board()).tasks[0]!.detail, /Prepare a precise list of fixes/);
  assert.match((await h.board()).tasks[0]!.detail, /missing regression test/);
  await h.complete();
  assert.deepEqual((await h.board()).tasks.map(t => t.title), ["implement", "Check: review"]);
  await h.complete("PASS");
  assert.deepEqual((await h.board()).tasks.map(t => t.title), ["finalize"]);
  await h.complete();
  const done = (await h.engine.runs(w.id)).find(r => r.id === run.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.steps.find(s => s.step === "plan")!.again, undefined);
  assert.equal(done.steps.find(s => s.step === "implement")!.again, 1);
  assert.equal(done.steps.find(s => s.step === "fixes")!.name, "Fixer");
});

test("agent errors stop the run instead of taking its conditional failure path", async t => {
  const h = await harness(t);
  const w = await h.save([h.step("review", 0, "QA", { kind: "check", otherwise: "fixes" }), h.step("fixes", 1)]);
  await h.engine.start(w, "test");
  await h.complete("Usage limit", true);
  assert.equal((await h.engine.runs(w.id))[0]!.status, "failed");
  assert.ok(!(await h.engine.runs(w.id))[0]!.steps.some(s => s.step === "fixes"));
});

test("a passing review skips its unused failure path and does not post it after Finalize", async t => {
  const h = await harness(t);
  const w = await h.save([h.step("implement", 0), h.step("review", 1, "QA", { kind: "check", next: "finalize", otherwise: "fixes" }), h.step("finalize", 2, "Dev", { next: "$finish" }), h.step("fixes", 3, "Fixer")]);
  await h.engine.start(w, "test");
  await h.complete("PASS");
  await h.complete();
  const done = (await h.engine.runs(w.id))[0]!;
  assert.equal(done.status, "done");
  assert.ok(!done.steps.some(s => s.step === "fixes"));
});

test("legacy checks still send work back to the explicitly chosen fixer without new connections", async t => {
  const h = await harness(t);
  const fixer = h.step("fixer", 0, "Fixer").mate;
  const w = await h.save([h.step("implement", 0), h.step("review", 1, "QA", { kind: "check", ifNot: "back", back: "implement", fixBy: fixer, tries: 1 })]);
  await h.engine.start(w, "test");
  await h.complete("FAIL: fix it");
  assert.equal((await h.board()).tasks[0]!.next || (await h.board()).tasks[0]!.name, "Fixer");
  await h.complete("PASS");
  assert.equal((await h.engine.runs(w.id))[0]!.status, "done");
});

test("a failure connection to Finish stops instead of reporting success", async t => {
  const h = await harness(t);
  const w = await h.save([h.step("implement", 0), h.step("review", 1, "QA", { kind: "check", otherwise: "$finish" })]);
  await h.engine.start(w, "test");
  await h.complete("FAIL: missing test");
  assert.equal((await h.engine.runs(w.id))[0]!.status, "stopped");
});

test("explicit failure routes still respect the check's retry budget", async t => {
  const h = await harness(t);
  const w = await h.save([h.step("implement", 0), h.step("review", 1, "QA", { kind: "check", otherwise: "implement", tries: 1 })]);
  await h.engine.start(w, "test");
  await h.complete("FAIL: still broken");
  await h.complete("FAIL: still broken");
  assert.equal((await h.engine.runs(w.id))[0]!.status, "failed");
  assert.match((await h.engine.runs(w.id))[0]!.note!, /after 1 try/);
});

test("successful circular connections stop at the global bound and cannot spin forever", async t => {
  const h = await harness(t);
  const w = await h.save([h.step("implement", 0, "Dev", { next: "implement" })]);
  const run = await h.engine.start(w, "test");
  // Exercise the last allowed transition without producing a hundred unrelated boards.
  const key = `friday:teammates:workflow-runs:${w.id}`;
  await h.kv.redis.lset(key, 0, JSON.stringify({ ...run, connections: MAX_CONNECTIONS_PER_RUN }));
  await h.complete();
  assert.equal((await h.engine.runs(w.id))[0]!.status, "failed");
  assert.match((await h.engine.runs(w.id))[0]!.note!, /loop without an exit/);
});

test("human approvals retain their pause and take the selected success connection", async t => {
  const h = await harness(t);
  const w = await h.save([h.step("implement", 0), h.step("approval", 1, "Dev", { kind: "approve", next: "$finish" }), h.step("skipped", 2)]);
  const run = await h.engine.start(w, "test");
  await h.complete();
  assert.equal((await h.engine.runs(w.id))[0]!.status, "asking");
  const done = await h.engine.answer(w, run.id, true, "Ship it");
  assert.equal(done.status, "done");
  assert.ok(!done.steps.some(s => s.step === "skipped"));
});

test("a fix step runs only when its check fails: passing goes on past it, and with no next it goes back to the work it fixes", async t => {
  const h = await harness(t);
  // As design A builds it: no "end the run" on the last step, no next on the fix step.
  const w = await h.save([
    h.step("plan", 0), h.step("implement", 1),
    h.step("review", 2, "QA", { kind: "check", ifNot: "back", otherwise: "fixes" }),
    h.step("finalize", 3, "Dev"),
    h.step("fixes", 4, "Fixer", { does: "List exactly what to fix", fixFor: "review" }),
  ]);
  const run = await h.engine.start(w, "test");
  await h.complete("FAIL: no test for the empty cart");
  assert.deepEqual((await h.board()).tasks.map(t => t.title), ["List exactly what to fix"]);
  await h.complete();
  // Back to the work the check checks, then the check again.
  assert.deepEqual((await h.board()).tasks.map(t => t.title), ["implement", "Check: review"]);
  await h.complete("PASS");
  assert.deepEqual((await h.board()).tasks.map(t => t.title), ["finalize"]);
  await h.complete();
  // Finalize was the end: the run never walked on into the fix step.
  const done = (await h.engine.runs(w.id)).find(r => r.id === run.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.steps.filter(s => s.step === "fixes").length, 1);
});
