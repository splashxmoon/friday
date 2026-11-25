// Friday on this computer answers as soon as it listens, and brings back what was going when it last closed afterwards, in the
// background: only the sessions that had something going, read from their logs then (spec 13, Wave 2 · G, Arun 2026-11-24: "Go
// all out and fix these problems"). A message sent to a lane that isn't back yet waits in its queue, and two looks at one session
// at once (the start's and a page opening it) say it went offline once.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Nothing on this computer is started or read: the coding tools point nowhere, and their folders are under a scratch home.
const scratch = await mkdtemp(path.join(tmpdir(), "friday-boot-"));
process.env.FRIDAY_STATE_DIR = path.join(scratch, "state");
process.env.FRIDAY_WORKTREES = path.join(scratch, "worktrees");
process.env.FRIDAY_CLAUDE_BIN = path.join(scratch, "no-claude");
process.env.FRIDAY_NO_TELEMETRY = "1";
const { createApp } = await import("../src/app.js");
const { localKV } = await import("../src/local/kv.js");
const { NO_MODELS } = await import("../src/local/no-models.js");
const { pendingFor, runOf } = await import("../src/session/projection.js");
const { liveIn } = await import("../src/reattach.js");
const { LogStore } = await import("../src/local/logs.js");
const { MAIN_LANE } = await import("../src/types.js");
test.after(() => rm(scratch, { recursive: true, force: true }));

const me = { id: "local", name: "Me", kind: "human" } as const;
const tool = { id: "engine:local", name: "Me's Claude Code", kind: "agent" } as const;

async function friday(home: string, restoreAfter?: Promise<unknown>) {
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" }, ...(restoreAfter ? { restoreAfter } : {}) } });
  const post = (p: string, body: unknown) => fetch(`${app.url}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ sessionId: string }>);
  return { kv, app, post, close: async () => (await app.close(), await kv.close()) };
}

test("the server answers before what was going is brought back; only sessions that had something going are read; a message to a lane not back yet waits for it", async (t) => {
  const home = path.join(scratch, "home1");
  const gone = path.join(scratch, "a-folder-since-deleted");
  const first = await friday(home);
  await first.app.restored;
  // Working when Friday closed: its tool attached (by a Friday since gone) and a run under way.
  const working = (await first.post("/api/sessions", { title: "Working" })).sessionId;
  await first.app.store.append(working, me, { type: "engine.attached", engine: { tool: "claude", cwd: gone, hostId: "local", hostName: "Me", mode: "full", node: "a-friday-gone" } });
  await first.app.core.handle(working, { id: "local", name: "Me" }, { type: "instruct", text: "Fix the login bug." });
  const asked = (await first.app.store.events(working)).findLast((e) => e.body.type === "instruction")!.seq;
  await first.app.store.appendAll(working, tool, [{ type: "run.started", causedBy: asked }, { type: "instructions.delivered", seqs: [asked] }]);
  // Its tool gone before Friday closed: nothing going.
  const idle = (await first.post("/api/sessions", { title: "Idle" })).sessionId;
  await first.app.store.append(idle, me, { type: "engine.attached", engine: { tool: "claude", cwd: gone, hostId: "local", hostName: "Me", mode: "full", node: first.app.hub.node } });
  await first.app.hub.reap(idle);
  await first.app.store.settleLive(idle, liveIn);
  // Never had a tool.
  const plain = (await first.post("/api/sessions", { title: "Plain" })).sessionId;
  for (let i = 0; i < 50; i++) await first.app.core.handle(plain, { id: "local", name: "Me" }, { type: "say", text: `note ${i}` });
  await first.close();

  // Started again, what was going held back until the test lets it go.
  const read: string[] = [];
  const warm = LogStore.prototype.warm;
  LogStore.prototype.warm = function (key, s, e) {
    read.push(key);
    return warm.call(this, key, s, e);
  };
  t.after(() => void (LogStore.prototype.warm = warm));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  const second = await friday(home, gate);
  t.after(() => second.close());
  assert.equal((await fetch(`${second.app.url}/api/info`)).ok, true, "answering");
  assert.deepEqual(read, [], "no session's log read to start");
  assert.equal(second.kv.logs.memory().cached, 0);
  // Before it is brought back: a message for the lane. It goes into the lane's queue, not lost.
  await second.app.core.handle(working, { id: "local", name: "Me" }, { type: "instruct", text: "And the signup page." });
  const later = (await second.app.store.events(working)).findLast((e) => e.body.type === "instruction")!.seq;
  assert.equal((await second.app.store.state(working)).engines[MAIN_LANE]?.online, true, "not looked over yet: that comes after");
  read.length = 0;
  go();
  await second.app.restored;
  const keys = [...new Set(read)].map((k) => /\{(.+)\}/.exec(k)![1]);
  assert.ok(!keys.includes(plain) && !keys.includes(idle), `only what had something going was read (${keys.join(", ")})`);
  const state = await second.app.store.state(working);
  assert.equal(state.engines[MAIN_LANE]?.online, false, "its tool said gone (EngineHub.sole)");
  assert.notEqual(runOf(state, MAIN_LANE).status, "running");
  assert.deepEqual(pendingFor(state, MAIN_LANE), [asked, later], "the turn the restart cut and the message sent meanwhile both wait for the lane");
  const events = await second.app.store.events(working);
  assert.equal(events.filter((e) => e.body.type === "engine.detached").length, 1, "said gone once");
  // Its folder is gone, so its tool couldn't come back: nothing is going, and the next start skips it.
  assert.deepEqual(await second.app.store.liveSessions(), []);
});

test("a session looked over twice at once (Friday starting, a page opening it) is said offline once", async (t) => {
  const home = path.join(scratch, "home2");
  const f = await friday(home);
  t.after(() => f.close());
  await f.app.restored;
  const sid = (await f.post("/api/sessions", { title: "Twice" })).sessionId;
  await f.app.store.append(sid, me, { type: "engine.attached", engine: { tool: "claude", cwd: scratch, hostId: "local", hostName: "Me", mode: "full", node: "a-friday-gone" } });
  await Promise.all([f.app.hub.reap(sid, false), f.app.hub.reap(sid), f.app.hub.reap(sid, false)]);
  const events = await f.app.store.events(sid);
  assert.equal(events.filter((e) => e.body.type === "engine.detached").length, 1);
});

test("what has something going is kept on the list as it is written, and taken off once nothing is", async (t) => {
  const home = path.join(scratch, "home3");
  const f = await friday(home);
  t.after(() => f.close());
  await f.app.restored;
  assert.deepEqual(await f.app.store.liveSessions(), [], "filled at the first start (nothing then)");
  const sid = (await f.post("/api/sessions", { title: "Run" })).sessionId;
  assert.deepEqual(await f.app.store.liveSessions(), [], "a new session has nothing going");
  await f.app.store.appendAll(sid, tool, [{ type: "run.started", causedBy: 1 }]);
  assert.deepEqual(await f.app.store.liveSessions(), [sid]);
  await f.app.store.settleLive(sid, liveIn);
  assert.deepEqual(await f.app.store.liveSessions(), [sid], "still going: stays");
  await f.app.store.append(sid, tool, { type: "run.ended", outcome: "done" });
  await f.app.store.settleLive(sid, liveIn);
  assert.deepEqual(await f.app.store.liveSessions(), [], "ended: off");
});
