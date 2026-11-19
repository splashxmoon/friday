// A crew mate's threads (teammates.ts Room.thread; Arun, 2026-11-15: "adding new threads and stuff when chatting with the
// agents"): each its own room of that one crew mate, named by the person's first message, apart from the crew's rooms, and gone
// with the crew mate.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { NEW_THREAD, threadTitle } from "../src/teammates.js";

process.env.FRIDAY_TEAMMATES_DRY = "1";
process.env.FRIDAY_EDITION = "local";

test("a thread is named by the first line of the person's first message, cut at a word", () => {
  assert.equal(threadTitle("Find what five competitors charge per seat"), "Find what five competitors charge per seat");
  assert.equal(threadTitle("\n**Draft** the `weekly` update\nwith numbers"), "Draft the weekly update");
  const long = threadTitle("Write a launch post for the new pricing page and the announcement email that goes with it");
  assert.ok(long.length <= 49 && long.endsWith("…"), long);
  assert.equal(threadTitle("   "), NEW_THREAD);
});

test("a crew mate's threads are rooms of its own, named by what you first say, kept apart from the rooms, and go with it", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-crew-threads-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const headers = { "Content-Type": "application/json", "x-friday-local": "1" };
  const call = async (url: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${app.url}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const kit = (await call("/api/teammates", "POST", { name: "Kit", role: "Research and ops.", tool: "claude", folder: path.join(home, "Kit") })).body.teammates.find((x: any) => x.name === "Kit");
  const made = await call("/api/teammates/rooms", "POST", { thread: kit.id });
  assert.equal(made.status, 200);
  const th = made.body.rooms.find((r: any) => r.id === made.body.room);
  assert.equal(th.thread, kit.id);
  assert.deepEqual(Object.keys(th.lanes), [kit.id], "Kit alone is in it");
  assert.equal(th.name, NEW_THREAD);
  // Your first words name it.
  await app.store.append(th.sid, { id: "local", name: "Me", kind: "human" }, { type: "instruction", text: "Draft the weekly update\nwith numbers", interrupt: false, attachments: [] }, { lane: th.lanes[kit.id] });
  const named = (await call("/api/teammates")).body.rooms.find((r: any) => r.id === th.id);
  assert.equal(named.name, "Draft the weekly update");
  // Nobody joins a thread.
  const rex = (await call("/api/teammates", "POST", { name: "Rex", role: "Reviews.", tool: "codex", folder: path.join(home, "Rex") })).body.teammates.find((x: any) => x.name === "Rex");
  await call(`/api/teammates/rooms/${th.id}`, "PATCH", { members: [kit.id, rex.id] });
  assert.deepEqual(Object.keys((await call("/api/teammates")).body.rooms.find((r: any) => r.id === th.id).lanes), [kit.id]);
  // A thread of someone no longer in the crew isn't made.
  assert.equal((await call("/api/teammates/rooms", "POST", { thread: "nobody123" })).status, 400);
  // Removing Kit takes its threads with it.
  await call(`/api/teammates/${kit.id}`, "DELETE");
  assert.equal((await call("/api/teammates")).body.rooms.filter((r: any) => r.thread === kit.id).length, 0);
});

// Its home chat deleted (app.ts /api/teammates/:id/clear; Arun, 2026-11-19: "why cant i delete this thread?"): New thread again,
// the conversation gone from view (projection's cleared), its coding tool on a fresh conversation, and never mid-turn.
test("a crew mate's home chat deleted starts over: New thread again, a fresh conversation for its tool, never mid-turn", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-crew-home-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const headers = { "Content-Type": "application/json", "x-friday-local": "1" };
  const call = async (url: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${app.url}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const got = (await call("/api/teammates", "POST", { name: "Ivy", role: "Writes.", tool: "claude", folder: path.join(home, "Ivy") })).body;
  const ivy = got.teammates.find((x: any) => x.name === "Ivy");
  const me = { id: "local", name: "Me", kind: "human" as const };
  await app.store.append(got.sid, me, { type: "instruction", text: "Draft the launch notes", interrupt: false, attachments: [] }, { lane: ivy.lane });
  assert.equal((await call("/api/teammates")).body.teammates.find((x: any) => x.id === ivy.id).homeTitle, "Draft the launch notes");
  // Mid-turn, it waits.
  await app.store.append(got.sid, { id: "agent", name: "Ivy", kind: "agent" }, { type: "run.started", causedBy: 0 } as any, { lane: ivy.lane });
  const busy = await call(`/api/teammates/${ivy.id}/clear`, "POST");
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /Ivy is working in it/);
  await app.store.append(got.sid, { id: "agent", name: "Ivy", kind: "agent" }, { type: "run.ended", outcome: "done" } as any, { lane: ivy.lane });
  const before = app.teammates.starts.length;
  const done = await call(`/api/teammates/${ivy.id}/clear`, "POST");
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const after = done.body.teammates.find((x: any) => x.id === ivy.id);
  assert.equal(after.homeTitle, undefined, "nothing said since: New thread");
  const cut = (await app.store.state(got.sid)).cleared?.[ivy.lane];
  assert.ok(cut, "the lane's conversation is cut there");
  // Started again on a conversation of its own, never the old one.
  const start = app.teammates.starts.slice(before).find((p: any) => p.lane === ivy.lane) as any;
  assert.ok(start, "its tool started again");
  assert.equal(start.keepAs, `${ivy.id.slice(0, 30)}#${cut}`);
  assert.ok(start.keepAs.length <= 40 && !start.keepAs.includes("."));
  // What it is told next is named again.
  await app.store.append(got.sid, me, { type: "instruction", text: "Plan the blog post", interrupt: false, attachments: [] }, { lane: ivy.lane });
  assert.equal((await call("/api/teammates")).body.teammates.find((x: any) => x.id === ivy.id).homeTitle, "Plan the blog post");
});
