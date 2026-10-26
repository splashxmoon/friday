import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionStore, WorkspaceClosing } from "../src/session/store.js";

/**
 * A session deleted is buried (store.bury): a write that arrives late (a run's last step, a machine's last word, another
 * server) is refused instead of starting a new log under its id. And no session starts in a workspace being deleted.
 */

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const ada = { id: "ada", name: "Ada" };
const agent = { id: "agent:friday", name: "Friday", kind: "agent" as const };

async function rig(t: test.TestContext) {
  const prefix = `mpatest:bury${randomUUID().slice(0, 8)}:`;
  const redis = new Redis(REDIS);
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });
  return { prefix, redis, store: new SessionStore(redis, prefix) };
}

test("a buried session takes no more writes: append and appendAll are refused as gone, and nothing comes back", async (t) => {
  const { prefix, redis, store } = await rig(t);
  await store.create("s1", "Cart", { ...ada, role: "owner" }, {}, "w");
  const live = await store.append("s1", agent, { type: "run.ended", outcome: "done" });
  assert.equal(live.ok, true, "a live session takes the write");

  await store.bury("s1");
  const keys = await redis.keys(`${prefix}{s1}*`);
  await redis.del(...keys);

  assert.deepEqual(await store.append("s1", agent, { type: "run.ended", outcome: "done" }), { ok: false, reason: "gone", driver: "", epoch: "0" });
  const all = await store.appendAll("s1", agent, [{ type: "run.ended", outcome: "done" }, { type: "run.ended", outcome: "done" }], { bumpEpoch: true });
  assert.equal(all.ok, false);
  assert.equal(!all.ok && all.reason, "gone");
  // Another server's store (its own cache, the same Redis): refused too.
  assert.equal((await new SessionStore(redis, prefix).append("s1", agent, { type: "run.ended", outcome: "done" })).ok, false);
  assert.equal(await store.exists("s1"), false);
  assert.deepEqual(await redis.keys(`${prefix}{s1}*`), [], "no log, no control hash, nothing under its id");
  assert.equal(await store.buried("s1"), true);
});

test("no session starts in a workspace being deleted", async (t) => {
  const { prefix, redis, store } = await rig(t);
  await redis.set(store.closingKey("w"), "1");
  await assert.rejects(store.create("s2", "Late", { ...ada, role: "owner" }, {}, "w"), WorkspaceClosing);
  assert.equal(await store.exists("s2"), false);
  assert.deepEqual(await store.mine(ada.id), [], "and it isn't on anyone's list");
  await store.create("s3", "Elsewhere", { ...ada, role: "owner" }, {}, "other");
  assert.equal(await store.exists("s3"), true, "another workspace is unaffected");
  void prefix;
});
