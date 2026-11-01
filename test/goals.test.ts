// Goals Friday drives (goals.ts): every goal the person has going, from a session's own, a hub's and a Crew room's run on its
// own, each on track, waiting on them, at risk and why, or met (Arun, 2026-10-31: Friday as the intelligence layer).
import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { goalChoices, goalsIn, rankGoals, type TrackedGoal } from "../src/goals.js";
import { needsIn } from "../src/needs-you.js";
import { collectBrief } from "../src/daily-brief.js";
import { SessionStore } from "../src/session/store.js";
import { MAIN_LANE, type EventBody } from "../src/types.js";

const maya = { id: "u-maya", name: "Maya Chen" };
const person = { ...maya, kind: "human" } as const;
const agent = { id: "agent", name: "Claude Code", kind: "agent" } as const;
const friday = { id: "goal", name: "Goal", kind: "system" } as const;
const H = 3600_000;

async function storeFor(t: test.TestContext) {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const add = (sid: string, body: EventBody, who: { id: string; name: string; kind: "agent" | "human" | "system" } = agent, lane = MAIN_LANE) => store.append(sid, who, body, { lane }).then((r) => (r as { seq: number }).seq);
  const session = async (sid: string, title: string, options: Record<string, unknown> = {}) => (await store.create(sid, title, { ...maya, role: "owner" }, options, "w1"), sid);
  const goals = async (sid: string, now: number) => goalsIn(await store.state(sid), await store.events(sid), now);
  return { add, session, goals, store };
}

test("a session's goal: on track while it moves, stalled when nothing has for hours, overdue past its time, behind its deadline's pace", async (t) => {
  const { add, session, goals } = await storeFor(t);
  const sid = await session("g1", "Refunds page");
  const now = Date.now();
  await add(sid, { type: "goal.set", text: "Refunds page shipped with tests passing", due: now + 10 * H }, person);
  // The agent's plan, as coding tools write theirs (a todo list): 1 of 4 done.
  const todos = ["API", "page", "tests", "PR"].map((content, i) => ({ content, status: i === 0 ? "completed" : "pending" }));
  await add(sid, { type: "agent.message", text: "On it.", toolCalls: [{ id: "c1", name: "todo", arguments: JSON.stringify({ todos }) }] } as EventBody);
  const [g] = await goals(sid, now);
  assert.equal(g!.status, "on-track");
  assert.deepEqual([g!.kind, g!.due, g!.where.title], ["goal", now + 10 * H, "Refunds page"]);
  // Three hours on, nobody on it, nothing moved.
  const stalled = (await goals(sid, now + 3 * H))[0]!;
  assert.deepEqual([stalled.status, stalled.risk], ["at-risk", "stalled"]);
  assert.match(stalled.why!, /Nothing has moved for 3h and nobody is on it/);
  // Past its time.
  assert.equal((await goals(sid, now + 11 * H))[0]!.risk, "overdue");
  // Running, so not stalled, but 1 of 4 steps done with 70% of the time gone: behind.
  await add(sid, { type: "run.started", causedBy: 1 });
  const behind = (await goals(sid, now + 7 * H))[0]!;
  assert.deepEqual([behind.risk, behind.why], ["behind", "1 of 4 done with 70% of the time gone."]);
});

test("a goal whose check keeps failing is going in circles; one waiting on the person's answer says so; a met one is told for a day", async (t) => {
  const { add, session, goals } = await storeFor(t);
  const sid = await session("g2", "Checkout tests");
  const now = Date.now();
  await add(sid, { type: "goal.set", text: "npm test passes" }, person);
  for (let i = 0; i < 3; i++) await add(sid, { type: "goal.checked", runSeq: 1, met: false, why: "2 tests still fail in cart.test.ts", nudge: true }, friday);
  const circling = (await goals(sid, now))[0]!;
  assert.deepEqual([circling.status, circling.risk], ["at-risk", "circling"]);
  assert.match(circling.why!, /failed 3 times: 2 tests still fail in cart\.test\.ts/);

  const sid2 = await session("g3", "Billing");
  await add(sid2, { type: "goal.set", text: "Invoices export as CSV" }, person);
  await add(sid2, { type: "engine.approval", id: "ap1", scope: "commands", items: ["npm publish"] } as EventBody);
  assert.deepEqual(((await goals(sid2, now))[0]!).status, "waiting");

  await add(sid, { type: "goal.checked", runSeq: 2, met: true, why: "All 48 tests pass." }, friday);
  assert.equal((await goals(sid, now))[0]!.status, "met");
  assert.equal((await goals(sid, now + 25 * H)).length, 0, "gone after a day");
});

test("a Crew room running on its own toward a goal is one too, due at its end time, met when the lead says GOAL REACHED", async (t) => {
  const { add, session, goals } = await storeFor(t);
  const sid = await session("g4", "Launch week", { team: true });
  const now = Date.now();
  await add(sid, { type: "team.selfrun", on: true, goal: "Launch posts ready", due: now + 5 * H }, person);
  const [g] = await goals(sid, now);
  assert.deepEqual([g!.kind, g!.text, g!.due, g!.where.room, g!.status], ["room", "Launch posts ready", now + 5 * H, true, "on-track"]);
  assert.equal((await goals(sid, now + 4 * H))[0]!.risk, "stalled", "nothing moved for 4h");
  await add(sid, { type: "team.selfrun", on: false, why: "The lead says the goal is reached." });
  assert.equal((await goals(sid, now))[0]!.status, "met");
  // Turned off without reaching it: no goal any more.
  const sid2 = await session("g5", "Docs room", { team: true });
  await add(sid2, { type: "team.selfrun", on: true, goal: "Docs rewritten" }, person);
  await add(sid2, { type: "team.selfrun", on: false, why: "Turned off." }, person);
  assert.equal((await goals(sid2, now)).length, 0);
});

test("goals are ranked at risk first, then waiting on you, then by deadline; the answers for one at risk carry on or re-plan", () => {
  const g = (id: string, status: TrackedGoal["status"], due?: number): TrackedGoal => ({ id, kind: "goal", text: id, where: { sid: id, title: id, lane: MAIN_LANE, room: false }, since: 0, moved: 0, status, ...(due ? { due } : {}) });
  assert.deepEqual(rankGoals([g("a", "on-track", 50), g("b", "waiting"), g("c", "at-risk"), g("d", "on-track", 10)]).map((x) => x.id), ["c", "b", "d", "a"]);
  const [keep, replan] = goalChoices({ ...g("Ship refunds", "at-risk"), why: "Nothing has moved for 3h." });
  assert.equal(keep!.label, "Keep going");
  assert.match(replan!.value, /The goal "Ship refunds" is off track: Nothing has moved for 3h\. Re-plan it/);
});

test("a goal at risk is in its setter's Needs you with keep going and re-plan, and in their brief; one on track with a deadline is today's plan", async (t) => {
  const { add, session, store } = await storeFor(t);
  const sid = await session("g6", "Refunds page");
  const now = Date.now();
  await add(sid, { type: "goal.set", text: "Refunds page shipped", due: now + 30 * H }, person);
  const read = async () => ({ state: await store.state(sid), events: await store.events(sid) });
  // On track: nothing to decide, and the brief's plan names it with its deadline.
  let s = await read();
  assert.equal(needsIn(s.state, s.events, maya.id, now).filter((f) => f.need.kind === "goal").length, 0);
  const brief = collectBrief({ me: maya.id, kind: "morning", since: now - H, until: now, tz: "UTC", sessions: [s] });
  assert.match(brief!.plan.find((p) => p.source === "goal")!.text, /“Refunds page shipped” is due/);
  // Stalled three hours later: one item, Friday's, with the two answers, sent to the agent on the goal.
  s = await read();
  const items = needsIn(s.state, s.events, maya.id, now + 3 * H).filter((f) => f.need.kind === "goal");
  assert.equal(items.length, 1);
  assert.deepEqual([items[0]!.need.who, items[0]!.need.choices.map((c) => c.label), items[0]!.act], ["Friday", ["Keep going", "Re-plan"], { do: "say", sid, lane: MAIN_LANE }]);
  assert.match(items[0]!.need.text, /“Refunds page shipped” is at risk: Nothing has moved for 3h/);
  // Not someone else's queue: they didn't set it.
  assert.equal(needsIn(s.state, s.events, "u-sam", now + 3 * H).filter((f) => f.need.kind === "goal").length, 0);
  const later = collectBrief({ me: maya.id, kind: "morning", since: now, until: now + 3 * H, tz: "UTC", sessions: [s] });
  assert.match(later!.risk.find((r) => r.kind === "goal")!.text, /is at risk: Nothing has moved for 3h/);
});
