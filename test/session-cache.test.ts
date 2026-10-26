import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { project } from "../src/session/projection.js";
import { SessionStore } from "../src/session/store.js";

/** A store over a fresh prefix, with every LRANGE it makes written down as "key-suffix from..to". */
function setup(t: { after: (fn: () => Promise<void>) => void }, budget: number, hotMs?: number) {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix, budget, null, hotMs);
  const reads: string[] = [];
  const lrange = redis.lrange.bind(redis);
  redis.lrange = ((key: string, from: number, to: number) => {
    reads.push(`${from}..${to}`);
    return lrange(key, from, to);
  }) as never;
  return { store, reads };
}

test("over its budget the cache keeps a session's state and drops its events: the state catches up from the tail, the events are read again in full", async (t) => {
  // A budget of one byte: every session but the one just read is over it. None counts as in use (store.ts HOT_MS): that a
  // session read a moment ago keeps its events over budget is tested on its own (store-hot-cache.test.ts).
  const { store, reads } = setup(t, 1, 0);

  await store.create("s1", "t", { id: "u-ada", name: "Ada", role: "owner" }, {}, "w");
  assert.equal((await store.state("s1")).lastSeq, 1);
  await store.append("s1", { id: "u-bob", name: "Bob", kind: "human" }, { type: "member.joined", role: "editor" });

  const state = await store.state("s1");
  assert.equal(state.lastSeq, 2);
  assert.equal(state.members["u-bob"]?.role, "editor");
  assert.deepEqual(reads, ["0..999", "1..-1"], "the state read only what was new");

  // Another session read after it pushes its events out.
  await store.create("s2", "t", { id: "u-ada", name: "Ada", role: "owner" }, {}, "w");
  await store.events("s2");
  reads.length = 0;
  const events = await store.events("s1");
  assert.equal(events.length, 2);
  assert.deepEqual(reads, ["0..999"], "the events were dropped, so they are read again whole");
  assert.deepEqual(await store.state("s1"), project("s1", events), "and the state is what folding the whole log gives");
});

test("a log bigger than the whole budget keeps its events while it is the one being read: it isn't read whole on every call", async (t) => {
  const { store, reads } = setup(t, 1);
  await store.create("big", "t", { id: "u-ada", name: "Ada", role: "owner" }, {}, "w");
  await store.events("big");
  await store.append("big", { id: "u-bob", name: "Bob", kind: "human" }, { type: "member.joined", role: "editor" });
  assert.equal((await store.events("big")).length, 2);
  assert.equal((await store.events("big")).length, 2);
  assert.deepEqual(reads, ["0..999", "1..-1"], "one whole read, then only the tail");
});

test("callers reading a session nobody has read yet share one whole read of its log", async (t) => {
  const { store, reads } = setup(t, 32 * 1024 * 1024);
  await store.create("s1", "t", { id: "u-ada", name: "Ada", role: "owner" }, {}, "w");
  // A second store over the same Redis is a server that has just restarted: nothing cached.
  const fresh = new SessionStore(store.redis, store.prefix);
  reads.length = 0;
  const all = await Promise.all([fresh.events("s1"), fresh.events("s1"), fresh.state("s1"), fresh.events("s1")]);
  assert.deepEqual(reads, ["0..999"], "one LRANGE of the whole log for four callers");
  assert.equal((all[0] as unknown[]).length, 1);
  assert.equal(all[0], all[1], "and they got the same array");
});
