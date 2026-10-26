import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionStore } from "../src/session/store.js";
import type { ActorRef } from "../src/types.js";

// Edge Defense, 2026-10-24: one session's log grew past the cache's whole budget, every read of any other session dropped its
// events, and it was read whole from Redis every few seconds until the server ran out of memory ("Reconnecting…" over and over).
test("a session in use keeps its events in the cache even when it alone is over budget", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix, 4_000);
  const who: ActorRef = { id: "u", name: "Ada", kind: "human" };
  await store.append("big", who, { type: "session.created", title: "Big", ownerId: "u", ownerName: "Ada" });
  for (let i = 0; i < 20; i++) await store.append("big", who, { type: "instruction", text: "x".repeat(400), interrupt: false });
  await store.append("small", who, { type: "session.created", title: "Small", ownerId: "u", ownerName: "Ada" });

  await store.events("big");
  const held = store.cacheStats.bytes;
  assert.ok(held > 4_000, `the big log alone is over budget (${held} bytes)`);
  // Reading another session used to drop the big one's events, and its next read took them all from Redis again.
  let whole = 0;
  const lrange = redis.lrange.bind(redis);
  redis.lrange = ((key: string, start: number, end: number) => {
    // A whole read starts at the log's first event (it reads in batches); a read of what is new starts further on.
    if (key.includes("big") && start === 0) whole++;
    return lrange(key, start, end);
  }) as typeof redis.lrange;
  await store.events("small");
  await store.events("big");
  await store.events("small");
  await store.events("big");
  assert.equal(whole, 0, "the big log is never read whole again while it is in use");
  assert.ok(store.cacheStats.bytes >= held, "its events are still held");
});

test("catching up with a busy log never reads it whole again: events appended while it read, or applied by another read, are taken as they are", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const writer = new SessionStore(redis, prefix);
  const who: ActorRef = { id: "u", name: "Ada", kind: "human" };
  const bot: ActorRef = { id: "a", name: "Codex", kind: "agent" };
  await writer.append("s", who, { type: "session.created", title: "Busy", ownerId: "u", ownerName: "Ada" });
  await store.events("s");
  let whole = 0;
  const lrange = redis.lrange.bind(redis);
  let sneak = 0;
  redis.lrange = (async (key: string, start: number, end: number) => {
    if (start === 0) whole++;
    // An agent logs its next steps between the length being read and this read.
    if (sneak > 0) {
      sneak--;
      await writer.append("s", bot, { type: "agent.message", text: "a step", toolCalls: [] });
      await writer.append("s", bot, { type: "agent.message", text: "another", toolCalls: [] });
    }
    return lrange(key, start, end);
  }) as typeof redis.lrange;
  await writer.append("s", bot, { type: "agent.message", text: "first", toolCalls: [] });
  sneak = 1;
  let events = await store.events("s");
  assert.equal(events.length, 4, "it took the two that came while it read");
  assert.ok(events.every((e, i) => e.seq === i + 1));
  // Two reads catching up at once: one applies the new events first, the other takes only what is left.
  for (let i = 0; i < 3; i++) await writer.append("s", bot, { type: "agent.message", text: `m${i}`, toolCalls: [] });
  const [a, b] = await Promise.all([store.events("s"), store.events("s")]);
  assert.equal(a.length, 7);
  assert.equal(b.length, 7);
  events = await store.events("s");
  assert.ok(events.every((e, i) => e.seq === i + 1), "no event twice, none missing");
  assert.equal(whole, 0, "never read whole");
  assert.equal((await store.state("s")).lastSeq, 7);
});
