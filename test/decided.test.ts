import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { buildCatchUp, decidedSince } from "../src/session/catchup.js";
import { SessionCore } from "../src/session/core.js";
import { project } from "../src/session/projection.js";
import { SessionStore } from "../src/session/store.js";
import { MAIN_LANE, type EventBody, type SessionEvent } from "../src/types.js";

/**
 * "Mark as decided" (ported from Friday Teams f262d06c): a message marked as decided from its menu is kept in the session's memory
 * (`decision:<seq>`) and told to every agent: on joining (the catch-up), every turn after (decidedSince), and in where we left off
 * (left-off reads the session's memory).
 */

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

test("a message marked as decided is kept in the session's memory, by who said it, and the mark comes off again", async (t) => {
  const { core, store } = await room(t);
  const said = await core.handle("s1", ada, { type: "say", text: "Totals are computed   on the server only." });
  if (!said.ok) throw new Error(said.error);
  const on = await core.handle("s1", ada, { type: "decide", seq: said.seq!, on: true });
  assert.equal(on.ok, true);
  const kept = (await store.state("s1")).memory.find((m) => m.key === `decision:${said.seq}`);
  assert.equal(kept?.text, "Decided (Ada): Totals are computed on the server only.");
  // Only something someone said: a line Friday drew isn't a decision.
  const created = (await store.events("s1")).find((e) => e.body.type === "session.created")!;
  assert.equal((await core.handle("s1", ada, { type: "decide", seq: created.seq, on: true })).ok, false);
  assert.equal((await core.handle("s1", ada, { type: "decide", seq: 999, on: true })).ok, false);
  // Off: an empty memory, which no agent reads.
  assert.equal((await core.handle("s1", ada, { type: "decide", seq: said.seq!, on: false })).ok, true);
  assert.equal((await store.state("s1")).memory.find((m) => m.key === `decision:${said.seq}`)?.text, "");
});

test("a watcher can't mark a decision", async (t) => {
  const { core, store } = await room(t);
  const said = await core.handle("s1", ada, { type: "say", text: "Ship it Friday." });
  assert.ok(said.ok);
  await store.ensureMember("s1", { id: "u-viewer", name: "Vic", role: "viewer" }, await store.state("s1"));
  const r = await core.handle("s1", { id: "u-viewer", name: "Vic" }, { type: "decide", seq: said.seq!, on: true });
  assert.equal(r.ok, false);
});

const ADA = { id: "u-ada", name: "Ada", kind: "human" as const };
const AGENT = { id: "engine:u-ada", name: "Claude Code", kind: "agent" as const };
const log = (rows: [typeof ADA | typeof AGENT, EventBody, string?][]): SessionEvent[] => rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: 1000 + i, actor, body, ...(lane ? { lane } : {}) }) as SessionEvent);
const instr = (text: string): EventBody => ({ type: "instruction", text, interrupt: false, attachments: [] });

test("every agent hears a decision: in its catch-up on joining, and on its next turn after, once", () => {
  const events = log([
    [ADA, { type: "session.created", title: "Checkout", ownerId: "u-ada", ownerName: "Ada" }],
    [ADA, instr("Fix the totals")],
    [AGENT, { type: "instructions.delivered", seqs: [2] }],
    [AGENT, { type: "agent.message", text: "Done.", toolCalls: [] }],
    [ADA, { type: "chat", text: "Totals are computed on the server only." }],
    [ADA, { type: "memory.saved", key: "decision:5", text: "Decided (Ada): Totals are computed on the server only.", auto: true }],
    [ADA, instr("Now the tax")],
    [AGENT, { type: "instructions.delivered", seqs: [7] }],
  ]);
  const state = project("s", events);
  // A newcomer's catch-up has it, as settled.
  assert.match(buildCatchUp(state, events, [7], "other"), /Decided \(Ada\): Totals are computed on the server only\./);
  // The agent already here hears it with its next turn, said to stand.
  const next = decidedSince(state, events, MAIN_LANE, [7]);
  assert.match(next, /Decided \(Ada\): Totals are computed on the server only\./);
  assert.match(next, /ask before you act/);
  // And not again on the turn after.
  const later = log([...events.map((e) => [e.actor, e.body, e.lane] as [typeof ADA, EventBody, string?]), [ADA, instr("And the receipts")], [AGENT, { type: "instructions.delivered", seqs: [9] }]]);
  assert.equal(decidedSince(project("s", later), later, MAIN_LANE, [9]), "");
});

test("a mark taken off says nothing; its first turn has no 'since'", () => {
  const events = log([
    [ADA, { type: "session.created", title: "Checkout", ownerId: "u-ada", ownerName: "Ada" }],
    [ADA, instr("Fix the totals")],
    [AGENT, { type: "instructions.delivered", seqs: [2] }],
    [ADA, { type: "memory.saved", key: "decision:2", text: "Decided (Ada): Fix the totals", auto: true }],
    [ADA, { type: "memory.saved", key: "decision:2", text: "", auto: true }],
    [ADA, instr("Next")],
    [AGENT, { type: "instructions.delivered", seqs: [6] }],
  ]);
  assert.equal(decidedSince(project("s", events), events, MAIN_LANE, [6]), "");
  assert.equal(decidedSince(project("s", events.slice(0, 3)), events.slice(0, 3), MAIN_LANE, [2]), "");
});
