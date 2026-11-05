// Ready to ship (ready.ts; Arun, 2026-11-01, the impress map): every agent's finished work across your sessions, proven first.
import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { proofLine, rankReady, readyIn, type ReadyItem } from "../src/ready.js";
import { SessionStore } from "../src/session/store.js";
import { MAIN_LANE, type EventBody } from "../src/types.js";

const maya = { id: "u-maya", name: "Maya Chen" };
const agent = { id: "agent", name: "Claude Code", kind: "agent" } as const;
const file = (path: string, additions: number, deletions: number) => ({ path, status: "modified" as const, additions, deletions, patch: "" });

test("finished work with its changes is ready; work still running, or none changed, or merged, isn't", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const add = (sid: string, body: EventBody, lane = MAIN_LANE) => store.append(sid, agent, body, { lane });
  await store.create("r1", "Refunds page", { ...maya, role: "owner" }, {}, "w1");
  await add("r1", { type: "agent.diff", base: "b0", files: [file("src/refunds.ts", 120, 14), file("test/refunds.test.ts", 40, 0)] } as EventBody);
  const [item] = readyIn(await store.state("r1"));
  assert.deepEqual([item!.files, item!.additions, item!.deletions, item!.where], [2, 160, 14, "Refunds page"]);
  assert.equal(proofLine(item!), "not checked yet");

  // Running again: not finished.
  await add("r1", { type: "run.started", causedBy: 1 });
  assert.equal(readyIn(await store.state("r1")).length, 0);
  await add("r1", { type: "run.ended", outcome: "done" } as EventBody);
  assert.equal(readyIn(await store.state("r1")).length, 1);

  // Its pull request merged: shipped.
  await add("r1", { type: "folder.committed", branch: "refunds", message: "Refunds", files: 2, prUrl: "https://github.com/acme/app/pull/7" } as EventBody);
  await add("r1", { type: "pr.status", url: "https://github.com/acme/app/pull/7", merged: true } as unknown as EventBody);
  const after = readyIn(await store.state("r1"));
  assert.ok(after.length === 0 || after.every((i) => i.pr), "with a pull request it says so, merged it goes");
});

test("proven work comes first, then the rest, then what has a pull request open; newest first in each", () => {
  const i = (sid: string, more: Partial<ReadyItem>): ReadyItem => ({ sid, where: sid, lane: MAIN_LANE, who: "Ada", files: 1, additions: sid.charCodeAt(0), deletions: 0, seq: 1, waiting: false, ...more });
  const at: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 };
  const ranked = rankReady([i("a", {}), i("b", { checks: { ok: true, command: "npm test" } }), i("c", { pr: { url: "u", merged: false } }), i("d", { review: { ok: true, by: "Lux", note: "" } })], (x) => at[x.sid]!);
  assert.deepEqual(ranked.map((x) => x.sid), ["d", "b", "a", "c"]);
  // One teammate's same changes, seen from two rooms it works in: once.
  const twice = rankReady([i("e", { who: "Nova", files: 580, additions: 497 }), i("f", { who: "Nova", files: 580, additions: 497 })], (x) => at[x.sid] ?? 0);
  assert.equal(twice.length, 1, "the same changes from two rooms show once");
  assert.equal(proofLine(i("x", { checks: { ok: true, command: "npm test" }, review: { ok: false, by: "Lux", note: "" } })), "tests passed · Lux asked for changes");
});

test("in a room with a board, a teammate's changes count only with a task done or being checked", () => {
  const diff = { base: "b0", seq: 3, files: [file("src/a.ts", 5, 0)] };
  const base = { id: "r2", title: "Crew", lanes: [{ id: "l1", name: "Nova" }], engines: {}, diffs: { l1: diff }, laneRuns: {}, members: {} } as unknown as Parameters<typeof readyIn>[0];
  const open = { ...base, board: { seq: 1, tasks: [{ id: "t1", title: "Cut the trailer", lane: "l1", status: "open" }] } } as typeof base;
  const done = { ...base, board: { seq: 1, tasks: [{ id: "t1", title: "Cut the trailer", lane: "l1", status: "done" }] } } as typeof base;
  assert.equal(readyIn(open).length, 0, "changes with no finished task are work in progress");
  assert.equal(readyIn(done)[0]?.task, "Cut the trailer");
});

test("work is named for the agent as the session shows it, never the main lane's inner name", () => {
  const diff = { base: "b0", seq: 3, files: [file("README.md", 4, 0)] };
  const base = { id: "r3", title: "Add a notes section", lanes: [{ id: "l2", name: "Claude Code 2" }], engines: { [MAIN_LANE]: { tool: "claude" } }, diffs: { [MAIN_LANE]: diff, l2: diff }, laneRuns: {}, members: {}, options: {}, run: { status: "idle" } } as unknown as Parameters<typeof readyIn>[0];
  const [main, second] = readyIn(base);
  assert.equal(main?.who, "Claude Code", "the home screen said “Main's changes” over Claude Code's work");
  assert.equal(second?.who, "Claude Code 2");
  assert.equal(main?.where, "Add a notes section");
  assert.equal(readyIn({ ...base, mainName: "Ada" } as typeof base)[0]?.who, "Ada", "a name somebody gave it comes first");
  assert.equal(readyIn({ ...base, engines: {} } as typeof base)[0]?.who, "Friday Code", "no coding tool: Friday's own agent");
});
