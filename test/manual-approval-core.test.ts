import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionCore } from "../src/session/core.js";
import { SessionStore } from "../src/session/store.js";

const ada = { id: "u-ada", name: "Ada" };

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
  return { core, store };
}

test("only a request that is waiting can be answered, and the answer is recorded with it", async (t) => {
  const { core, store } = await room(t);
  await store.append("s1", { id: "agent:friday", name: "Friday Code", kind: "agent" }, { type: "engine.approval", id: "k1", scope: "commands", items: ["npm test"] });
  assert.equal((await store.state("s1")).approvals.main?.id, "k1");

  const stale = await core.handle("s1", ada, { type: "instruct", text: "Yes.", approval: { id: "nope", approve: true } });
  assert.equal(stale.ok, false, "an id that isn't waiting is refused");

  const yes = await core.handle("s1", ada, { type: "instruct", text: "Yes, run it.", approval: { id: "k1", approve: true } });
  assert.equal(yes.ok, true);
  const events = await store.events("s1");
  const ans = events.findLast((e) => e.body.type === "instruction");
  assert.deepEqual(ans?.body.type === "instruction" ? ans.body.approval : null, { id: "k1", approve: true });
  assert.equal((await store.state("s1")).approvals.main, undefined, "answered, so no longer waiting");

  const again = await core.handle("s1", ada, { type: "instruct", text: "Yes.", approval: { id: "k1", approve: true } });
  assert.equal(again.ok, false, "and it can't be answered twice");
});
