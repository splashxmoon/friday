import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { SessionStore, trimOutput } from "../src/session/store.js";
import type { ActorRef, SessionEvent } from "../src/types.js";

// A long session's log grew past what the server could hold (Edge Defense's: 33 MB, 12 of it tool output), Arun, 2026-10-24:
// "make very long sessions take less memory on the server, so a session that keeps growing can't run it out of memory again".

function setup(t: { after: (fn: () => Promise<void>) => void }, keepWhole: number) {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  return { redis, store: new SessionStore(redis, prefix, 32 * 1024 * 1024, null, undefined, keepWhole) };
}
const who: ActorRef = { id: "u", name: "Ada", kind: "human" };
const bot: ActorRef = { id: "a", name: "Codex", kind: "agent" };
const long = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

test("a tool's long output is held as its start and end, with how much was left out", () => {
  const out = long(2000);
  const held = trimOutput(out);
  assert.ok(held.length < 2400);
  assert.ok(held.startsWith("line 0\nline 1"));
  assert.ok(held.endsWith("line 1999"));
  assert.match(held, /\[…\d+ characters left out of the middle\]/);
  assert.equal(trimOutput("short"), "short");
});

test("old long tool output is held trimmed in memory, the newest events whole, and a page is given it as logged", async (t) => {
  const { store } = setup(t, 3);
  const output = long(3000);
  await store.append("s", who, { type: "session.created", title: "Long", ownerId: "u", ownerName: "Ada" });
  await store.append("s", bot, { type: "tool.result", callId: "c1", name: "shell", output, isError: false });
  for (let i = 0; i < 4; i++) await store.append("s", bot, { type: "agent.message", text: `step ${i}`, toolCalls: [] });

  const events = await store.events("s");
  const old = events[1]!;
  assert.equal(old.body.type, "tool.result");
  assert.ok(old.body.type === "tool.result" && old.body.output.length < output.length && /left out of the middle/.test(old.body.output), "held trimmed");
  assert.ok(store.cacheStats.bytes < output.length, "and counted as what is held");
  const shown = await store.asLogged("s", events);
  assert.ok(shown[1]!.body.type === "tool.result" && shown[1]!.body.output === output, "a page gets it whole");
  assert.equal(shown[2], events[2], "the rest as they were");

  // A long output among the newest is whole; once newer events push it back, it is trimmed too.
  await store.append("s", bot, { type: "tool.result", callId: "c2", name: "shell", output, isError: false });
  let latest = await store.events("s");
  assert.ok(latest.at(-1)!.body.type === "tool.result" && (latest.at(-1)!.body as { output: string }).output === output);
  for (let i = 0; i < 3; i++) await store.append("s", bot, { type: "agent.message", text: `more ${i}`, toolCalls: [] });
  latest = await store.events("s");
  const pushed = latest.find((e) => e.body.type === "tool.result" && e.body.callId === "c2")!;
  assert.ok(pushed.body.type === "tool.result" && /left out of the middle/.test(pushed.body.output), "trimmed once it is old");
  assert.ok((await store.asLogged("s", [pushed]))[0]!.body.type === "tool.result");
});

test("a whole log read in batches comes back whole and in order", async (t) => {
  const { redis, store } = setup(t, 2000);
  const key = store.keys("big").events;
  const n = 2_350;
  const rows: string[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const body = seq === 1 ? { type: "session.created", title: "Big", ownerId: "u", ownerName: "Ada" } : { type: "agent.message", text: `m${seq}`, toolCalls: [] };
    rows.push(JSON.stringify({ seq, ts: seq, actor: seq === 1 ? who : bot, body } as SessionEvent));
  }
  for (let i = 0; i < rows.length; i += 500) await redis.rpush(key, ...rows.slice(i, i + 500));
  const events = await store.events("big");
  assert.equal(events.length, n);
  assert.ok(events.every((e, i) => e.seq === i + 1), "every event, in order");
  assert.equal((await store.state("big")).lastSeq, n);
});

test("whole-log reads of different sessions take turns, so a restart's reconnects can't hold every log twice over at once", async (t) => {
  const { redis, store } = setup(t, 2000);
  for (const sid of ["a", "b"]) await store.append(sid, who, { type: "session.created", title: sid, ownerId: "u", ownerName: "Ada" });
  // A fresh store over the same Redis is a server just started: nothing cached, both read whole.
  const fresh = new SessionStore(redis, store.prefix);
  const log: string[] = [];
  const lrange = redis.lrange.bind(redis);
  redis.lrange = (async (key: string, start: number, end: number) => {
    const sid = key.includes("{a}") || key.includes(":a:") ? "a" : "b";
    log.push(`${sid} start`);
    await new Promise((r) => setTimeout(r, 30));
    const out = await lrange(key, start, end);
    log.push(`${sid} end`);
    return out;
  }) as typeof redis.lrange;
  await Promise.all([fresh.events("a"), fresh.events("b")]);
  assert.deepEqual(log, ["a start", "a end", "b start", "b end"], `one after the other: ${log.join(", ")}`);
});
