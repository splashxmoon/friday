import assert from "node:assert/strict";
import { Redis } from "ioredis";
import test from "node:test";
import { internPatches, lightLog, refPatches } from "../src/session/patches.js";
import { sessionKeys } from "../src/session/keys.js";
import { SessionStore } from "../src/session/store.js";
import { MAIN_LANE, type ActorRef, type DiffFile, type SessionEvent } from "../src/types.js";

// Arun, 2026-10-21: "how can we live save the events without live losing everything and saving space on the server". A session's
// change sets logged the same fifty patches again every turn: 22 of its 33 MB, and the server ran out of memory opening it.

const ada = { id: "u-ada", name: "Ada", kind: "human" as const };
const agent: ActorRef = { id: "engine:u-ada", name: "Ada's Claude Code", kind: "agent" };
const file = (path: string, patch: string): DiffFile => ({ path, status: "modified", additions: 1, deletions: 1, patch });
const BIG = `@@ -1 +1 @@\n-${"old ".repeat(2000)}\n+${"new ".repeat(2000)}\n`;

test("a patch the lane logged last time is written as a reference to it, and read back whole, the very same string", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  await store.create("s1", "Cart", { ...ada, role: "owner" }, {}, "w");
  await store.state("s1");
  const first = await store.append("s1", agent, { type: "agent.diff", base: "b", files: [file("a.ts", BIG), file("b.ts", "@@ b1")] });
  // Next turn: a.ts as it was, b.ts changed, c.ts new.
  const second = await store.append("s1", agent, { type: "agent.diff", base: "b", files: [file("a.ts", BIG), file("b.ts", "@@ b2"), file("c.ts", "@@ c")] });
  assert.ok(first.ok && second.ok);
  // Third: a.ts still the same, pointing at where its text has been all along, not at the change set before.
  const third = await store.append("s1", agent, { type: "agent.diff", base: "b", files: [file("a.ts", BIG), file("b.ts", "@@ b2")] });
  assert.ok(third.ok);

  const raw = (await redis.lrange(sessionKeys(prefix, "s1").events, -3, -1)).map((r) => JSON.parse(r) as SessionEvent);
  const files = (e: SessionEvent) => (e.body.type === "agent.diff" ? e.body.files : []);
  assert.equal(files(raw[0]!)[0]!.patch, BIG, "the first time, the text itself");
  assert.deepEqual(files(raw[1]!).map((f) => [f.path, f.patch === "" ? "ref" : "text", f.at]), [["a.ts", "ref", first.seq], ["b.ts", "text", undefined], ["c.ts", "text", undefined]]);
  assert.deepEqual(files(raw[2]!).map((f) => [f.path, f.at]), [["a.ts", first.seq], ["b.ts", second.seq]]);
  const size = (e: SessionEvent) => JSON.stringify(e).length;
  assert.ok(size(raw[1]!) < 1000 && size(raw[2]!) < 1000, "a repeated 16 KB patch costs a few bytes");

  // Read back, by this process and by a fresh one reading the whole log (another server, a restart): whole, one string.
  for (const s of [store, new SessionStore(redis, prefix)]) {
    const events = await s.events("s1");
    const [a, b, c] = events.slice(-3).map(files);
    assert.equal(b![0]!.patch, BIG);
    assert.equal(c![1]!.patch, "@@ b2");
    assert.ok(a![0]!.patch === b![0]!.patch && b![0]!.patch === c![0]!.patch);
    const state = await s.state("s1");
    assert.equal(state.diffs[MAIN_LANE]!.files[0]!.patch, BIG, "the state's change set is whole too");
  }
});

test("a log from before references: the same patch logged again is made one string, and given where it is kept", () => {
  const ev = (seq: number, files: DiffFile[], lane?: string): SessionEvent => ({ seq, ts: seq, actor: agent, body: { type: "agent.diff", base: "b", files }, ...(lane ? { lane } : {}) });
  // Parsed separately, as JSON.parse makes them: equal text, different strings.
  const log = [ev(1, [file("a.ts", JSON.parse(JSON.stringify(BIG)))]), ev(2, [file("x.ts", "@@ x")], "l2"), ev(3, [file("a.ts", JSON.parse(JSON.stringify(BIG)))])];
  internPatches(log);
  const a3 = log[2]!.body.type === "agent.diff" ? log[2]!.body.files[0]! : null;
  assert.equal(a3?.at, 1, "kept at the first, the other lane's change set in between not counted");
  assert.equal(a3?.patch, BIG);

  // Opening the session: each lane's latest whole, the older ones by name with where to fetch each file's text.
  const light = lightLog(log);
  const sent = light.map((e) => (e.body.type === "agent.diff" ? e.body.files.map((f) => [f.path, f.patch ? "text" : "none", f.later]) : []));
  assert.deepEqual(sent, [[["a.ts", "none", 1]], [["x.ts", "text", undefined]], [["a.ts", "text", undefined]]]);
  assert.equal(log[0]!.body.type === "agent.diff" && log[0]!.body.files[0]!.patch, BIG, "the cache's own events are left whole");
});

test("only a patch the same as the last one is a reference: changed, cut short differently, or empty, it is written out", () => {
  const last = { seq: 7, files: [file("a.ts", "@@ a"), { ...file("b.ts", "@@ b"), truncated: true }, file("e.ts", ""), { ...file("r.ts", "@@ r"), at: 3 }] };
  const out = refPatches([file("a.ts", "@@ a"), file("b.ts", "@@ b"), file("e.ts", ""), file("r.ts", "@@ r"), file("n.ts", "@@ n")], last);
  assert.deepEqual(out.map((f) => [f.path, f.at]), [["a.ts", 7], ["b.ts", undefined], ["e.ts", undefined], ["r.ts", 3], ["n.ts", undefined]]);
  assert.equal(refPatches(out, undefined), out, "no change set before it: as it is");
});
