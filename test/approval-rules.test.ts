import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionCore } from "../src/session/core.js";
import { SessionStore } from "../src/session/store.js";

const ada = { id: "u-ada", name: "Ada" };
const bob = { id: "u-bob", name: "Bob" };
const cy = { id: "u-cy", name: "Cy" };

/** A session where Ada owns and drives, Bob is an editor, Cy a viewer, and an agent is asking before it runs something. */
async function room(t: { after: (f: () => Promise<void>) => void }, command: string) {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const core = new SessionCore(store, () => {});
  await store.create("s1", "Checkout", { ...ada, role: "owner" }, {}, "w");
  await store.append("s1", { ...bob, kind: "human" }, { type: "member.joined", role: "editor" });
  await store.append("s1", { ...cy, kind: "human" }, { type: "member.joined", role: "viewer" });
  assert.ok((await core.handle("s1", ada, { type: "instruct", text: "go" })).ok);
  await store.append("s1", { id: "agent:friday", name: "Friday Code", kind: "agent" }, { type: "engine.approval", id: "k1", scope: "commands", items: [command] });
  return { core, store };
}
const answered = async (store: SessionStore) => (await store.events("s1")).findLast((e) => e.body.type === "instruction" && e.body.approval);

test("by default only the driver and an owner can answer", async (t) => {
  const { core } = await room(t, "npm test");
  const r = await core.handle("s1", bob, { type: "approval.answer", id: "k1", approve: true });
  assert.equal(r.ok, false);
});

test("an owner can let editors approve some kinds of command, and only an owner can say so", async (t) => {
  const { core, store } = await room(t, "npm test");
  assert.equal((await core.handle("s1", bob, { type: "settings.update", approve: { editor: ["checks"] } })).ok, false, "an editor can't hand themselves the yes");
  assert.ok((await core.handle("s1", ada, { type: "settings.update", approve: { editor: ["checks", "checks", "nonsense"] } })).ok);
  assert.deepEqual((await store.state("s1")).options.approve, { editor: ["checks"] }, "known kinds only, once each");

  const yes = await core.handle("s1", bob, { type: "approval.answer", id: "k1", approve: true });
  assert.ok(yes.ok, yes.ok ? "" : yes.error);
  const ans = await answered(store);
  assert.equal(ans!.actor.id, bob.id, "it is Bob's answer, in the log under his name");
  assert.deepEqual(ans!.body.type === "instruction" ? ans!.body.approval : null, { id: "k1", approve: true });
  assert.equal((await store.state("s1")).approvals.main, undefined);
  assert.equal((await core.handle("s1", bob, { type: "approval.answer", id: "k1", approve: true })).ok, false, "not twice");
});

test("a command of a kind they may not approve is left to the driver, and the reason says which kind", async (t) => {
  const { core, store } = await room(t, "git push origin main");
  await core.handle("s1", ada, { type: "settings.update", approve: { editor: ["checks", "read", "build"] } });
  const r = await core.handle("s1", bob, { type: "approval.answer", id: "k1", approve: true });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /publish/i.test(r.error));
  assert.equal((await store.state("s1")).approvals.main?.id, "k1", "still waiting");
  assert.ok((await core.handle("s1", ada, { type: "approval.answer", id: "k1", approve: true })).ok, "the driver can still");
});

test("a line is approvable only if every part is", async (t) => {
  const { core } = await room(t, "npm test && rm -rf dist");
  await core.handle("s1", ada, { type: "settings.update", approve: { editor: ["checks", "read", "build", "install", "git"] } });
  assert.equal((await core.handle("s1", bob, { type: "approval.answer", id: "k1", approve: true })).ok, false);
});

test("a no counts the same as a yes: it takes the same standing to say it", async (t) => {
  const { core, store } = await room(t, "npm test");
  assert.equal((await core.handle("s1", bob, { type: "approval.answer", id: "k1", approve: false })).ok, false);
  await core.handle("s1", ada, { type: "settings.update", approve: { editor: ["checks"] } });
  assert.ok((await core.handle("s1", bob, { type: "approval.answer", id: "k1", approve: false })).ok);
  const ans = await answered(store);
  assert.deepEqual(ans!.body.type === "instruction" ? ans!.body.approval : null, { id: "k1", approve: false });
});

test("viewers can never approve, whatever editors are allowed", async (t) => {
  const { core } = await room(t, "npm test");
  await core.handle("s1", ada, { type: "settings.update", approve: { editor: ["checks"] } });
  assert.equal((await core.handle("s1", cy, { type: "approval.answer", id: "k1", approve: true })).ok, false);
});

test("a request that isn't about one command stays with the driver", async (t) => {
  const { core, store } = await room(t, "x");
  await store.append("s1", { id: "agent:friday", name: "Friday Code", kind: "agent" }, { type: "engine.approval", id: "k2", scope: "turn", items: [] });
  await core.handle("s1", ada, { type: "settings.update", approve: { editor: ["checks", "read", "build", "install", "git", "publish", "deploy", "destructive", "other"] } });
  const r = await core.handle("s1", bob, { type: "approval.answer", id: "k2", approve: true });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /isn't about a single command/.test(r.error));
});

test("the driver and an owner answer through the same command, without any setting", async (t) => {
  const { core } = await room(t, "rm -rf dist");
  assert.ok((await core.handle("s1", ada, { type: "approval.answer", id: "k1", approve: true })).ok);
});
