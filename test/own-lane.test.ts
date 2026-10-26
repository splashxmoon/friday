import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { canDriveLane } from "../src/session/projection.js";
import { SessionCore } from "../src/session/core.js";
import { SessionStore } from "../src/session/store.js";

const ada = { id: "u-ada", name: "Ada" };
const bob = { id: "u-bob", name: "Bob" };
const cy = { id: "u-cy", name: "Cy" };
const vi = { id: "u-vi", name: "Vi" };

/**
 * Bringing your own agent: a teammate's Claude Code, Codex or Cursor, signed in
 * on their machine under their account, gets a lane of its own. Only that — it
 * is theirs to drive, and takes nothing from anyone else's.
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
  const join = async (p: { id: string; name: string }, role: "editor" | "viewer") => void (await store.append("s1", { ...p, kind: "human" }, { type: "member.joined", role }));
  await join(bob, "editor");
  await join(cy, "editor");
  await join(vi, "viewer");
  return { core, store };
}

test("a teammate can add a lane for their own agent, and it is theirs to drive", async (t) => {
  const { core, store } = await room(t);
  const r = await core.handle("s1", bob, { type: "lane.add", name: "Bob's Claude Code", own: true });
  assert.equal(r.ok, true);
  const state = await store.state("s1");
  const lane = state.lanes.at(-1)!;
  assert.equal(lane.name, "Bob's Claude Code");
  assert.deepEqual(lane.control, { kind: "people", people: [bob.id] }, "whatever they asked for, it is driven by them");
  assert.equal(canDriveLane(state, bob.id, lane.id), true);
  assert.equal(canDriveLane(state, cy.id, lane.id), false, "another teammate can't take over somebody's account");
  assert.equal(canDriveLane(state, ada.id, lane.id), true, "the owner always can");
});

test("a teammate cannot add an ordinary lane, set how it is driven, or add one as a viewer", async (t) => {
  const { core, store } = await room(t);
  const plain = await core.handle("s1", bob, { type: "lane.add", name: "Sneaky" });
  assert.equal(plain.ok, false);
  assert.match((plain as { error: string }).error, /Only an owner/);

  // Asking for an open lane while adding their own still gets them their own.
  await core.handle("s1", bob, { type: "lane.add", name: "Bob's Codex", own: true, control: { kind: "open" } });
  const lane = (await store.state("s1")).lanes.at(-1)!;
  assert.equal(lane.control.kind, "people");

  const viewer = await core.handle("s1", vi, { type: "lane.add", name: "Vi's Cursor", own: true });
  assert.equal(viewer.ok, false, "watching is not steering");
});

test("an owner still adds any lane, as before, and the session's lane limit holds for everybody", async (t) => {
  const { core, store } = await room(t);
  assert.equal((await core.handle("s1", ada, { type: "lane.add", name: "Reviewer", control: { kind: "open" } })).ok, true);
  assert.equal((await store.state("s1")).lanes.at(-1)!.control.kind, "open");
  // Their own coding tools: the plan's limit on Friday agents doesn't apply, the session's does.
  for (let i = 0; i < 11; i++) assert.equal((await core.handle("s1", cy, { type: "lane.add", name: `Cy ${i}`, own: true, engine: true })).ok, true);
  const over = await core.handle("s1", bob, { type: "lane.add", name: "One too many", own: true, engine: true });
  assert.equal(over.ok, false);
  assert.match((over as { error: string }).error, /up to 12 agents/);
});

test("a teammate can change the model and how hard it thinks, and nothing else about the session", async (t) => {
  const { core, store } = await room(t);
  assert.equal((await core.handle("s1", bob, { type: "settings.update", model: "some/model", thinking: "deep" })).ok, true);
  const o = (await store.state("s1")).options;
  assert.equal(o.model, "some/model");
  assert.equal(o.thinking, "deep");

  for (const patch of [{ planFirst: true }, { webSearch: false }, { signoff: 2 }, { policy: { viewer: { control: true } } }, { model: "x", planFirst: true }]) {
    const r = await core.handle("s1", bob, { type: "settings.update", ...patch } as never);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match((r as { error: string }).error, /owner only/);
  }
  assert.equal((await store.state("s1")).options.planFirst, false);

  const viewer = await core.handle("s1", vi, { type: "settings.update", thinking: "fast" });
  assert.equal(viewer.ok, false, "a viewer steers nothing, so tunes nothing");
});

test("an editors-only lane still follows the session's policy: control off for editors means they can't drive it", async (t) => {
  const { core, store } = await room(t);
  assert.equal((await core.handle("s1", ada, { type: "lane.add", name: "Drafts", control: { kind: "role", role: "editor" } })).ok, true);
  const lane = (await store.state("s1")).lanes.at(-1)!;
  assert.equal(canDriveLane(await store.state("s1"), bob.id, lane.id), true, "an editor drives it while the policy lets editors steer");
  await store.append("s1", { ...ada, kind: "human" }, { type: "session.updated", options: { policy: { editor: { control: false } } } });
  const state = await store.state("s1");
  assert.equal(canDriveLane(state, bob.id, lane.id), false, "and not once the owner has turned that off");
  assert.equal(canDriveLane(state, ada.id, lane.id), true, "the owner always can");
  assert.equal(canDriveLane(state, vi.id, lane.id), false, "a viewer never could");
});

test("renaming a racing agent keeps it in the race: the name keeps its \"Race · \"", async (t) => {
  const { core, store } = await room(t);
  await core.handle("s1", ada, { type: "lane.add", name: "Race · A · Codex", control: { kind: "open" } });
  const lane = (await store.state("s1")).lanes.at(-1)!;
  assert.equal((await core.handle("s1", ada, { type: "lane.rename", laneId: lane.id, name: "Fast one" })).ok, true);
  assert.equal((await store.state("s1")).lanes.find((l) => l.id === lane.id)!.name, "Race · Fast one");
});
