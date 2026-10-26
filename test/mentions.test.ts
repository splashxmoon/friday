import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { attentionIn } from "../src/attention.js";
import { mentionsIn } from "../src/mentions.js";
import { initialState } from "../src/session/projection.js";
import { SessionCore } from "../src/session/core.js";
import { SessionStore } from "../src/session/store.js";

/** @-mentions and asides (mentions.ts, the "say" command, attention's "mention"). */
const room = () => ({
  ...initialState("s1"),
  members: {
    a: { name: "Arun Dass", role: "owner" as const },
    m: { name: "Maya Chen", role: "editor" as const },
    m2: { name: "Maya Ortiz", role: "editor" as const },
    p: { name: "Priya", role: "viewer" as const },
    gone: { name: "Gone Person", role: "editor" as const, removed: true },
  },
});

test("who a message names: full names always, first names only when nobody else shares them, never the writer or someone gone", () => {
  const s = room();
  assert.deepEqual(mentionsIn("@Priya can you look?", s, "a"), ["p"]);
  assert.deepEqual(mentionsIn("@Maya can you look?", s, "a"), [], "two Mayas: a first name alone is nobody");
  assert.deepEqual(mentionsIn("@Maya Chen, the migration", s, "a"), ["m"]);
  assert.deepEqual(mentionsIn("@Priyanka hi", s, "a"), [], "a longer word isn't her name");
  assert.deepEqual(mentionsIn("@Arun Dass note to self", s, "a"), [], "not yourself");
  assert.deepEqual(mentionsIn("@Gone Person?", s, "a"), [], "not someone removed");
  assert.deepEqual(mentionsIn("no at sign, Priya", s, "a"), []);
});

async function live(t: { after: (f: () => Promise<void>) => void }) {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const core = new SessionCore(store, () => {});
  await store.create("s1", "Checkout", { id: "a", name: "Arun Dass", role: "owner" }, {}, "w");
  for (const [id, name, role] of [["m", "Maya Chen", "editor"], ["p", "Priya", "viewer"]] as const) await store.append("s1", { id, name, kind: "human" }, { type: "member.joined", role });
  return { core, store };
}

test("an aside names someone: it waits on their list until they say anything, and anyone in the room may talk, watchers too", async (t) => {
  const { core, store } = await live(t);
  const said = await core.handle("s1", { id: "p", name: "Priya" }, { type: "say", text: "@Maya Chen is the migration safe to run?" });
  assert.equal(said.ok, true, "a viewer can talk to people");
  const ev = (await store.events("s1")).at(-1)!;
  assert.equal(ev.body.type, "chat");
  assert.deepEqual((ev.body as { mentions?: string[] }).mentions, ["m"]);

  let mine = attentionIn(await store.state("s1"), "m");
  assert.equal(mine.find((x) => x.kind === "mention")?.text, "Priya: @Maya Chen is the migration safe to run?");
  assert.equal(attentionIn(await store.state("s1"), "a").some((x) => x.kind === "mention"), false, "only the one named");

  await core.handle("s1", { id: "m", name: "Maya Chen" }, { type: "say", text: "Yes, it's reversible." });
  mine = attentionIn(await store.state("s1"), "m");
  assert.equal(mine.some((x) => x.kind === "mention"), false, "answering clears it");
});

test("a suggestion or an instruction that names someone carries the mention too", async (t) => {
  const { core, store } = await live(t);
  await core.handle("s1", { id: "a", name: "Arun Dass" }, { type: "instruct", text: "Add the index. @Priya will review." });
  const ev = (await store.events("s1")).findLast((e) => e.body.type === "instruction")!;
  assert.deepEqual((ev.body as { mentions?: string[] }).mentions, ["p"]);
});
