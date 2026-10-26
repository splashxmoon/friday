import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionCore } from "../src/session/core.js";
import { signoffStatus } from "../src/session/projection.js";
import { SessionStore } from "../src/session/store.js";

const ada = { id: "u-ada", name: "Ada" };
const bob = { id: "u-bob", name: "Bob" };
const cy = { id: "u-cy", name: "Cy" };
const vi = { id: "u-vi", name: "Vi" };

/**
 * Team sign-off: a plan can need a second pair of eyes before the agent gets
 * its hands back, and someone asking for changes holds it until they're met.
 */
async function room(t: { after: (f: () => Promise<void>) => void }) {
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
  const add = async (p: { id: string; name: string }, role: "editor" | "viewer") => void (await store.append("s1", { ...p, kind: "human" }, { type: "member.joined", role }));
  return { core, store, add };
}

test("a plan that needs sign-off waits for a teammate, and their word counts once", async (t) => {
  const { core, store, add } = await room(t);
  await add(bob, "editor");
  await add(cy, "editor");
  await core.handle("s1", ada, { type: "settings.update", planFirst: true, signoff: 1 });

  let r = await core.handle("s1", ada, { type: "plan.approve" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /1 more teammate/);

  // The approver agreeing with themselves is not a second opinion.
  assert.equal((await core.handle("s1", ada, { type: "plan.review", verdict: "approve" })).ok, true);
  assert.equal((await core.handle("s1", ada, { type: "plan.approve" })).ok, false);

  assert.equal((await core.handle("s1", bob, { type: "plan.review", verdict: "approve" })).ok, true);
  r = await core.handle("s1", ada, { type: "plan.approve" });
  assert.equal(r.ok, true, "one sign-off was asked for and one was given");
  assert.ok((await store.state("s1")).planApproved.main, "approved");
});

test("asking for changes blocks approval, with the reason, until the same person changes their mind", async (t) => {
  const { core, store, add } = await room(t);
  await add(bob, "editor");
  await core.handle("s1", ada, { type: "settings.update", planFirst: true, signoff: 1 });

  await core.handle("s1", bob, { type: "plan.review", verdict: "changes", note: "Step 3 drops the index." });
  const r = await core.handle("s1", ada, { type: "plan.approve" });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Bob asked for changes/);
  const st = await store.state("s1");
  assert.equal(signoffStatus(st, "main", ada.id).changes[0]?.note, "Step 3 drops the index.");

  await core.handle("s1", bob, { type: "plan.review", verdict: "approve" });
  assert.equal((await core.handle("s1", ada, { type: "plan.approve" })).ok, true);
});

test("a revised plan starts the reviews over", async (t) => {
  const { core, store, add } = await room(t);
  await add(bob, "editor");
  await core.handle("s1", ada, { type: "settings.update", planFirst: true, signoff: 1 });
  await core.handle("s1", bob, { type: "plan.review", verdict: "approve" });
  await store.append("s1", { id: "friday", name: "Friday Code", kind: "agent" }, { type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "update_plan", arguments: "{}" }] } as never);
  const r = await core.handle("s1", ada, { type: "plan.approve" });
  assert.equal(r.ok, false, "Bob approved the old plan, not this one");
});

test("the ask is capped by the people there are, viewers can't review, and off means the driver's call alone", async (t) => {
  const { core, add } = await room(t);
  await core.handle("s1", ada, { type: "settings.update", planFirst: true, signoff: 3 });
  assert.equal((await core.handle("s1", ada, { type: "plan.approve" })).ok, true, "nobody else is there to ask");

  const two = await room(t);
  await two.add(vi, "viewer");
  await two.core.handle("s1", ada, { type: "settings.update", planFirst: true, signoff: 1 });
  const v = await two.core.handle("s1", vi, { type: "plan.review", verdict: "approve" });
  assert.equal(v.ok, false, "a viewer's word isn't a sign-off");
  assert.equal((await two.core.handle("s1", ada, { type: "plan.approve" })).ok, true, "and a viewer isn't someone to wait for");
  void add;
});
