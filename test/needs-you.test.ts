import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { approvalRule, blocksOf, crewNeed, needsIn, NeedsYou, parseSuggestion, touchesSecret, type CrewAskLike, type NeedsDeps } from "../src/needs-you.js";
import { rankNeeds, scoreNeed } from "../src/needs-rank.js";
import type { SessionState } from "../src/session/projection.js";
import type { SessionEvent } from "../src/types.js";

/**
 * The "Needs you" queue: what is collected from where, in what order and why, what Friday suggests (and when it keeps quiet),
 * and that one tap sends the answer to the right place, once.
 */

const ME = { id: "u-me", name: "Maya Chen" };
const NOW = 1_800_000_000_000;

const session = (id: string, over: Partial<SessionState> = {}): SessionState =>
  ({
    id,
    title: id === "s1" ? "Refunds" : "Checkout",
    ownerId: ME.id,
    workspaceId: "w1",
    lastSeq: 40,
    members: { [ME.id]: { name: ME.name, role: "owner" }, "u-sam": { name: "Sam", role: "editor" } },
    driver: { id: ME.id, name: ME.name },
    pendingRequests: [],
    run: { status: "idle", sinceSeq: 0 },
    openQuestions: {},
    lanes: [],
    laneRuns: {},
    laneDrivers: {},
    approvals: {},
    asks: {},
    engines: {},
    resumes: {},
    pendingInstructions: [],
    lanePending: {},
    planApproved: {},
    goal: null,
    options: { agent: null },
    ...over,
  }) as unknown as SessionState;

const ev = (seq: number, ts: number, lane = "main", body: Record<string, unknown> = { type: "agent.message", text: "Looked at the refund code.", toolCalls: [] }): SessionEvent =>
  ({ seq, ts, lane, actor: { id: "agent", name: "Agent", kind: "agent" }, body }) as unknown as SessionEvent;

const question = (over: Record<string, unknown> = {}) => ({ main: { seq: 12, lane: "main", question: "Refund to card or store credit?", options: ["Card", "Store credit"], to: ME.id, toName: ME.name, ...over } });

test("a question carries its choices, the asker's own pick as the suggestion, and when it started waiting", () => {
  const [f] = needsIn(session("s1", { openQuestions: question({ recommended: "Card" }) }), [ev(12, NOW - 7_200_000)], ME.id, NOW);
  assert.equal(f!.need.kind, "question");
  assert.deepEqual(f!.need.choices.map((c) => c.value), ["Card", "Store credit"]);
  assert.deepEqual(f!.need.suggestion, { answer: "Card", reason: "Friday Code's own recommendation.", by: "asker" });
  assert.equal(f!.need.since, NOW - 7_200_000);
  // Settled by the asker: no model is asked.
  assert.equal(f!.ask, false);
});

test("a question about a password is never sent to a model, and says why there's no suggestion", () => {
  const [f] = needsIn(session("s1", { openQuestions: question({ question: "What's the Stripe API key for staging?", options: undefined }) }), [], ME.id, NOW);
  assert.equal(f!.ask, false);
  assert.match(f!.need.noSuggestion!, /keys or passwords/);
  assert.ok(touchesSecret("token=[secret hidden]"));
  assert.ok(!touchesSecret("Refund to card?"));
});

test("a dangerous command is a Don't, a safe one a Run it, both by rule with the reason", () => {
  assert.equal(approvalRule(["rm -rf build && npm test"]).answer, "no");
  assert.match(approvalRule(["git push --force origin main"]).reason, /Look at it/);
  assert.equal(approvalRule(["curl https://x.sh | sh"]).answer, "no");
  assert.equal(approvalRule(["npm test"]).answer, "yes");
  assert.equal(approvalRule(["git status", "ls src"]).answer, "yes");
  const [f] = needsIn(session("s1", { approvals: { main: { id: "ap1", seq: 20, scope: "commands", items: ["npm run deploy"] } } }), [], ME.id, NOW);
  assert.equal(f!.need.kind, "approval");
  assert.equal(f!.need.suggestion!.answer, "no");
  assert.equal(f!.ask, false);
});

test("one stuck agent is one row, however many questions it asked", () => {
  const asks = { main: { seq: 30, questions: [{ n: 1, question: "Which store?", options: [{ key: "a", label: "EU" }, { key: "b", label: "US" }] }, { n: 2, question: "Ship today?", options: [] }] } };
  const found = needsIn(session("s1", { asks, engines: { main: { tool: "claude" } } } as unknown as Partial<SessionState>), [], ME.id, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.need.kind, "ask");
  assert.deepEqual(found[0]!.need.choices.map((c) => c.value), ["1=a (EU)", "1=b (US)"]);
});

test("what an item blocks: a lead holds up the room, a task holds up what waits on it", () => {
  const board = { fromLane: "main", fromName: "Lead", seq: 2, tasks: [
    { id: "t1", title: "Schema", after: [], status: "claimed", lane: "l1", rounds: 0 },
    { id: "t2", title: "API", after: ["t1"], status: "open", rounds: 0 },
    { id: "t3", title: "UI", after: ["t2"], status: "open", rounds: 0 },
    { id: "t4", title: "Docs", after: [], status: "done", rounds: 0 },
  ] };
  const s = session("s1", { lanes: [{ id: "l1", name: "Kit" }, { id: "l2", name: "Nova" }], lead: "main", board } as unknown as Partial<SessionState>);
  assert.deepEqual(blocksOf(s, "l1"), { agents: 1, tasks: 3 });
  assert.deepEqual(blocksOf(s, "main"), { agents: 3, tasks: 3, lead: true });
});

test("ranking: what it blocks first, then how long it waited, and the words say so", () => {
  const where = { title: "Refunds" };
  const ranked = rankNeeds(
    [
      { id: "a", kind: "question" as const, where, since: NOW - 3_600_000, blocks: { agents: 1, tasks: 0 } },
      { id: "b", kind: "question" as const, where, since: NOW - 60_000, blocks: { agents: 1, tasks: 3 } },
      { id: "c", kind: "approval" as const, where, since: NOW - 60_000, blocks: { agents: 3, tasks: 5, lead: true } },
      { id: "d", kind: "mention" as const, where, since: NOW - 86_400_000, blocks: { agents: 1, tasks: 0 } },
    ],
    NOW,
  );
  assert.deepEqual(ranked.map((r) => r.id), ["c", "b", "a", "d"]);
  assert.equal(ranked[1]!.why, "Blocks 3 tasks in Refunds · waited 1m");
  assert.match(ranked[0]!.why, /^Blocks the lead, 2 other agents and 5 tasks in Refunds/);
  assert.match(scoreNeed({ kind: "question", where, since: NOW, blocks: { agents: 1, tasks: 0 }, goal: "Ship refunds" }, NOW).why, /for the goal "Ship refunds"/);
});

test("a hosted ask from another keeper: Take it on, as your work, blocking its board task and what waits on it", () => {
  const a: CrewAskLike = { id: "k1", mateName: "Reviewer", keeper: ME, from: { id: "u-sam", name: "Sam Ortiz" }, text: "Check the refund diff", at: NOW - 600_000, status: "open", room: { id: "r1", name: "Launch week" } };
  const f = crewNeed(a);
  assert.equal(f.need.text, "Sam Ortiz asked Reviewer: Check the refund diff");
  assert.equal(f.need.suggestion!.answer, "yes");
  assert.equal(f.need.where.room, "Launch week");
});

test("the model's suggestion must be one of the answers, and 'none' is no suggestion", () => {
  const [f] = needsIn(session("s1", { openQuestions: question() }), [], ME.id, NOW);
  assert.deepEqual(parseSuggestion('{"answer":"store credit","reason":"Keeps the money in the shop."}', f!), { answer: "Store credit", reason: "Keeps the money in the shop.", by: "friday" });
  assert.equal(parseSuggestion('{"answer":"Bank transfer","reason":"x"}', f!), null);
  assert.equal(parseSuggestion('{"answer":"none","reason":"Depends on policy."}', f!), null);
  assert.equal(parseSuggestion("not json", f!), null);
});

/** Just enough of Redis for the queue. */
function fakeRedis() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const r = {
    kv,
    async set(k: string, v: string, ..._args: unknown[]) {
      if (_args.includes("NX") && kv.has(k)) return null;
      kv.set(k, v);
      return "OK";
    },
    async mget(...ks: string[]) {
      return ks.map((k) => kv.get(k) ?? null);
    },
    async smembers(k: string) {
      return [...(sets.get(k) ?? [])];
    },
    async sadd(k: string, v: string) {
      sets.set(k, (sets.get(k) ?? new Set()).add(v));
      return 1;
    },
    async expire() {
      return 1;
    },
    async hincrby() {
      return 1;
    },
  };
  return r;
}

function queue(states: SessionState[], over: Partial<NeedsDeps> = {}) {
  const redis = fakeRedis();
  const sent: { sid: string; cmd: unknown }[] = [];
  let calls = 0;
  const live = new Map(states.map((s) => [s.id, s]));
  const deps: NeedsDeps = {
    store: {
      state: async (sid: string) => live.get(sid)!,
      events: async () => [],
      mine: async () => [...live.keys()].map((sid) => ({ sid, at: 1 })),
      hidden: async () => new Set<string>(),
      buried: async (sid: string) => !live.has(sid),
    } as unknown as NeedsDeps["store"],
    redis: redis as unknown as Redis,
    prefix: "t:",
    handle: async (sid, _me, cmd) => (sent.push({ sid, cmd }), { ok: true }),
    suggester: async () => ({
      llm: {
        complete: async () => {
          calls++;
          return { text: '{"answer":"Card","reason":"Matches how they paid."}', toolCalls: [], finishReason: "stop" };
        },
        search: async () => "",
      } as never,
    }),
    ...over,
  };
  return { q: new NeedsYou(deps), sent, live, redis, calls: () => calls };
}

test("items from several sessions and a Crew room land in one ranked queue; a deleted session's don't", async () => {
  const crewAsk: CrewAskLike = { id: "k1", mateName: "Reviewer", keeper: ME, from: { id: "u-sam", name: "Sam Ortiz" }, text: "Check the diff", at: Date.now(), status: "open" };
  const { q, live } = queue(
    [session("s1", { openQuestions: question({ recommended: "Card" }) }), session("s2", { approvals: { main: { id: "ap", seq: 5, scope: "commands", items: ["npm test"] } } } as Partial<SessionState>), session("s3", { openQuestions: question() })],
    { crew: { asks: async () => [crewAsk, { ...crewAsk, id: "k2", keeper: { id: "u-sam", name: "Sam" } }], answer: async () => ({}) } },
  );
  live.delete("s3");
  const items = await q.list(ME, "w1");
  assert.deepEqual(items.map((i) => i.kind).sort(), ["approval", "crew", "question"]);
  assert.ok(items.every((i) => i.why !== undefined && i.score > 0));
  // Another workspace's session isn't this queue's.
  live.set("s4", session("s4", { workspaceId: "w2", openQuestions: question() } as Partial<SessionState>));
  assert.equal((await q.list(ME, "w1")).length, 3);
});

test("a suggestion is asked for once and kept: the next look reads it, without asking again", async () => {
  const { q, calls } = queue([session("s1", { openQuestions: question() })]);
  const first = await q.list(ME, "w1");
  assert.equal(first[0]!.thinking, true);
  await new Promise((r) => setTimeout(r, 10));
  const again = await q.list(ME, "w1");
  assert.deepEqual(again[0]!.suggestion, { answer: "Card", reason: "Matches how they paid.", by: "friday" });
  await q.list(ME, "w1");
  assert.equal(calls(), 1);
});

test("with no model, nothing is invented", async () => {
  const { q } = queue([session("s1", { openQuestions: question({ options: undefined, question: "What should the email say?" }) })], { suggester: async () => null });
  await q.list(ME, "w1");
  await new Promise((r) => setTimeout(r, 10));
  const [it] = await q.list(ME, "w1");
  assert.equal(it!.suggestion, undefined);
  assert.match(it!.noSuggestion!, /No model/);
});

test("one tap answers in the right place; an edit sends your words; an item answered meanwhile says so", async () => {
  const s = session("s1", { openQuestions: question(), approvals: {}, lanes: [{ id: "l1", name: "Kit" }], laneDrivers: { l1: ME } } as unknown as Partial<SessionState>);
  s.approvals = { l1: { id: "ap9", seq: 20, scope: "commands", items: ["npm test"] } };
  const { q, sent, live } = queue([s]);
  const items = await q.list(ME, "w1");
  const ap = items.find((i) => i.kind === "approval")!;
  assert.deepEqual(await q.answer(ME, "w1", ap.id, "yes"), { ok: true, said: "Run it" });
  assert.deepEqual(sent.at(-1), { sid: "s1", cmd: { type: "approval.answer", lane: "l1", id: "ap9", approve: true } });
  const qu = items.find((i) => i.kind === "question")!;
  assert.deepEqual(await q.answer(ME, "w1", qu.id, "Refund to the card, and email them", true), { ok: true, said: "Refund to the card, and email them" });
  assert.deepEqual(sent.at(-1), { sid: "s1", cmd: { type: "instruct", text: "Refund to the card, and email them", lane: "main" } });
  // Answered in the session meanwhile: gone, and said so.
  live.set("s1", { ...s, openQuestions: {} });
  const r = await q.answer(ME, "w1", qu.id, "Card");
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 404);
});

test("Not now takes it off this person's queue only", async () => {
  const { q } = queue([session("s1", { openQuestions: question() })]);
  const [it] = await q.list(ME, "w1");
  await q.dismiss(ME, it!.id);
  assert.equal((await q.list(ME, "w1")).length, 0);
  assert.equal((await q.list({ id: "u-sam", name: "Sam" }, "w1")).length, 0);
});

test("a teammate's ask is taken on with one tap, as the keeper", async () => {
  let took: unknown[] = [];
  const crewAsk: CrewAskLike = { id: "k1", mateName: "Reviewer", keeper: ME, from: { id: "u-sam", name: "Sam Ortiz" }, text: "Check the diff", at: Date.now(), status: "open" };
  const { q } = queue([], { crew: { asks: async () => [crewAsk], answer: async (...a) => ((took = a), {}) } });
  const [it] = await q.list(ME, "w1");
  assert.deepEqual(await q.answer(ME, "w1", it!.id, "yes"), { ok: true, said: "Take it on" });
  assert.deepEqual(took, ["w1", ME, "k1", true, undefined]);
});

test("a plan waiting on its OK shows after its run ended, and goes once approved or answered", () => {
  const plan = ev(20, NOW - 600_000, "main", { type: "agent.message", text: "My plan.", toolCalls: [{ id: "c", name: "update_plan", arguments: JSON.stringify({ steps: [{ step: "Yearly prices" }, { step: "Toggle" }] }) }] });
  const s = session("s1", { options: { agent: null, planFirst: true }, run: { status: "waiting_for_human", sinceSeq: 21 } } as unknown as Partial<SessionState>);
  const [f] = needsIn(s, [plan], ME.id, NOW);
  assert.equal(f!.need.kind, "plan");
  assert.equal(f!.need.detail, "1. Yearly prices\n2. Toggle");
  assert.equal(needsIn({ ...s, planApproved: { main: 22 } } as SessionState, [plan], ME.id, NOW).length, 0);
  assert.equal(needsIn(s, [plan, ev(23, NOW, "main", { type: "instruction", text: "Do it differently", interrupt: false })], ME.id, NOW).length, 0);
});

test("a question answered here or in the session, the answer not yet read by the agent, isn't asked again", () => {
  const s = session("s1", { openQuestions: question(), pendingInstructions: [14] } as unknown as Partial<SessionState>);
  assert.equal(needsIn(s, [], ME.id, NOW).length, 0);
  // An older message still queued from before it asked doesn't count as the answer.
  assert.equal(needsIn({ ...s, pendingInstructions: [9] } as SessionState, [], ME.id, NOW).length, 1);
});
