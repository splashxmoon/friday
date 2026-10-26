import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionCore } from "../src/session/core.js";
import { SessionStore } from "../src/session/store.js";

const ada = { id: "u-ada", name: "Ada" };

async function room(t: { after: (fn: () => unknown) => void }) {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const core = new SessionCore(store, () => {});
  await store.create("s1", "t", { ...ada, role: "owner" }, {}, "w");
  const tool = { id: "engine:claude", name: "Ada's Claude Code", kind: "agent" as const };
  return { store, core, tool };
}

test("Stop leaves a coding tool free: there is nothing to resume, and its next message is simply its next task", async (t) => {
  const { store, core, tool } = await room(t);
  await store.append("s1", tool, { type: "engine.attached", engine: { tool: "claude", hostId: ada.id, hostName: "Ada", cwd: "/w", mode: "edits" } });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "Refactor the cart" })).ok);
  await store.append("s1", tool, { type: "instructions.delivered", seqs: (await store.state("s1")).pendingInstructions });
  await store.append("s1", tool, { type: "run.started", causedBy: 1 });
  assert.ok((await core.handle("s1", ada, { type: "run.pause" })).ok);
  assert.equal((await store.state("s1")).run.status, "idle", "stopped and free, not paused");
  assert.equal((await core.handle("s1", ada, { type: "run.resume" })).ok, false, "nothing to resume");
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "Now the checkout" })).ok);
  const s = await store.state("s1");
  assert.equal(s.pendingInstructions.length, 1, "its next task, for the tool's next turn");
  assert.ok(!(await store.events("s1")).some((e) => e.body.type === "run.resume"), "with no resume written for it");
});

test("Stop keeps what was queued, to go next; a cancel throws it away", async (t) => {
  const { store, core, tool } = await room(t);
  await store.append("s1", tool, { type: "engine.attached", engine: { tool: "claude", hostId: ada.id, hostName: "Ada", cwd: "/w", mode: "edits" } });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "Refactor the cart" })).ok);
  await store.append("s1", tool, { type: "instructions.delivered", seqs: (await store.state("s1")).pendingInstructions });
  await store.append("s1", tool, { type: "run.started", causedBy: 1 });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "and then the README" })).ok, "queued while it runs");
  assert.ok((await core.handle("s1", ada, { type: "run.pause" })).ok);
  assert.equal((await store.state("s1")).pendingInstructions.length, 1, "the README is still queued, and goes next");
  await store.append("s1", tool, { type: "instructions.delivered", seqs: (await store.state("s1")).pendingInstructions });
  await store.append("s1", tool, { type: "run.started", causedBy: 3 });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "and the tests" })).ok);
  assert.ok((await core.handle("s1", ada, { type: "run.cancel" })).ok);
  assert.equal((await store.state("s1")).pendingInstructions.length, 0, "a cancel clears the queue");
});

test("Send now on a second agent checks that agent's queue, not the main one's", async (t) => {
  const { store, core, tool } = await room(t);
  assert.ok((await core.handle("s1", ada, { type: "lane.add", name: "Second", control: { kind: "open" }, trigger: { kind: "manual" }, own: true, engine: true })).ok);
  const lane = (await store.state("s1")).lanes[0]!.id;
  await store.append("s1", tool, { type: "engine.attached", engine: { tool: "claude", hostId: ada.id, hostName: "Ada", cwd: "/w", mode: "edits" } }, { lane });
  await store.append("s1", tool, { type: "run.started", causedBy: 1 }, { lane });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "and then the README", lane })).ok, "queued while it runs");
  const r = await core.handle("s1", ada, { type: "run.interrupt", lane });
  assert.equal(r.ok, true, (r as { error?: string }).error);
});


test("Writing to a stopped coding tool that is offline queues the message, instead of marking it running with nobody to run it", async (t) => {
  const { store, core, tool } = await room(t);
  await store.append("s1", tool, { type: "engine.attached", engine: { tool: "claude", hostId: ada.id, hostName: "Ada", cwd: "/w", mode: "edits" } });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "Refactor the cart" })).ok);
  await store.append("s1", tool, { type: "instructions.delivered", seqs: (await store.state("s1")).pendingInstructions });
  await store.append("s1", tool, { type: "run.started", causedBy: 1 });
  assert.ok((await core.handle("s1", ada, { type: "run.pause" })).ok);
  await store.append("s1", tool, { type: "engine.detached", reason: "disconnected" });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "and the README" })).ok);
  const s = await store.state("s1");
  assert.equal(s.run.status, "idle");
  assert.equal(s.pendingInstructions.length, 1, "waiting for the tool to come back");
});

test("Editing a queued message keeps its place and is one write: a refused edit leaves the message as it was", async (t) => {
  const { store, core, tool } = await room(t);
  await store.append("s1", tool, { type: "engine.attached", engine: { tool: "claude", hostId: ada.id, hostName: "Ada", cwd: "/w", mode: "edits" } });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "Refactor the cart" })).ok);
  await store.append("s1", tool, { type: "instructions.delivered", seqs: (await store.state("s1")).pendingInstructions });
  await store.append("s1", tool, { type: "run.started", causedBy: 1 });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "then the README" })).ok);
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "then the tests" })).ok);
  const [first, second] = (await store.state("s1")).pendingInstructions;
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "then the README and the CHANGELOG", replaces: first })).ok);
  const s = await store.state("s1");
  const events = await store.events("s1");
  const text = (q: number) => (events.find((e) => e.seq === q)!.body as { text: string }).text;
  assert.deepEqual(s.pendingInstructions.map(text), ["then the README and the CHANGELOG", "then the tests"], "the edit is first, where the old one was");
  assert.ok(s.withdrawn.includes(first!), "and the old one is taken back");
  assert.ok(!events.some((e) => e.body.type === "instruction.withdrawn"), "in the same write, not a take-back first");

  // Delivered meanwhile: the edit is refused, and nothing else changes.
  await store.append("s1", tool, { type: "instructions.delivered", seqs: [second!] });
  const late = await core.handle("s1", ada, { type: "instruct", text: "then the e2e tests", replaces: second });
  assert.equal(late.ok, false);
  assert.match((late as { error?: string }).error ?? "", /already been delivered/);
  assert.equal((await store.state("s1")).pendingInstructions.length, 1, "the queue is as it was");
});
