import assert from "node:assert/strict";
import { test } from "node:test";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { aheadOfLimit, BurnTracker, estimate, forecastLine, pctOf, TYPICAL_MS, type Burn, type RunRecord } from "../src/forecast.js";
import { recordOf, RunLog } from "../src/run-log.js";
import { moveAhead, planAhead } from "../src/limit-ahead.js";
import { BENCH_ASOF } from "../src/model-bench.js";
import { learnedFrom, learnedView, revisionOf } from "../src/route-learning.js";
import { fitModels } from "../src/routing.js";
import { project, type LaneEngine, type SessionState } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/** Arun, 2026-10-31: forecasts before work starts, acting before a limit, and routing that learns from outcomes. */

const NOW = Date.UTC(2026, 9, 31, 15);
const MIN = 60_000;
const maya: ActorRef = { id: "u-maya", name: "Maya Chen", kind: "human" };
const sam: ActorRef = { id: "u-sam", name: "Sam Ortiz", kind: "human" };
const tool: ActorRef = { id: "engine", name: "Claude Code", kind: "agent" };

const rec = (over: Partial<RunRecord>): RunRecord => ({ at: NOW - 3_600_000, tool: "codex", model: "gpt-6-luna", tier: "standard", kind: "tests", repo: "github.com/acme/api", ms: 20 * MIN, tokens: 200_000, cost: 0.1, grade: 1, asof: BENCH_ASOF, ...over });
const many = (n: number, over: Partial<RunRecord>) => Array.from({ length: n }, (_, i) => rec({ at: NOW - (i + 1) * 3_600_000, ...over }));

// ── estimates from history ───────────────────────────────────────────

test("a first task with no history gets its tier's typical time, said as typical, and no share of a window", () => {
  const e = estimate([], { tool: "claude", tier: "heavy" }, NOW);
  assert.equal(e.ms, TYPICAL_MS.heavy);
  assert.equal(e.tokens, null);
  assert.equal(e.basis, "typical");
  assert.equal(forecastLine(e, { tier: "heavy", pct: pctOf(e.tokens, 20_000), tool: "Claude" }), "~40 min, typical for hard work");
});

test("a repo with a single run moves the forecast a little toward it; ten runs stand on their own", () => {
  const one = estimate([rec({ ms: 60 * MIN })], { tool: "codex", tier: "standard", kind: "tests", repo: "github.com/acme/api" }, NOW);
  // workspace level (1 run), then repo (1), then repo+kind (1), each shrunk toward the one above by three runs' worth
  assert.ok(one.ms > TYPICAL_MS.standard && one.ms < 40 * MIN, `${one.ms / MIN} min`);
  assert.equal(one.basis, "repo");
  const ten = estimate(many(10, { ms: 60 * MIN }), { tool: "codex", tier: "standard", kind: "tests", repo: "github.com/acme/api" }, NOW);
  // ten outweigh the typical figure three to one
  assert.ok(ten.ms > 45 * MIN, `${ten.ms / MIN} min`);
});

test("runs on another repo inform the workspace level only; the model's own runs come first", () => {
  const rs = [...many(6, { repo: "github.com/acme/web", ms: 10 * MIN }), ...many(6, { model: "gpt-6.1-sol", repo: "github.com/acme/web", ms: 50 * MIN })];
  const luna = estimate(rs, { tool: "codex", model: "gpt-6-luna", tier: "standard", repo: "github.com/acme/api" }, NOW);
  assert.equal(luna.basis, "workspace");
  assert.ok(luna.ms < 15 * MIN);
  const sol = estimate(rs, { tool: "codex", model: "gpt-6.1-sol", tier: "standard" }, NOW);
  assert.ok(sol.ms > 35 * MIN);
});

test("runs older than sixty days are not counted", () => {
  const e = estimate([rec({ at: NOW - 61 * 86_400_000, ms: 90 * MIN })], { tool: "codex", tier: "standard" }, NOW);
  assert.equal(e.basis, "typical");
});

test("the line says time and the share of the person's own window once their plan is known", () => {
  const e = estimate(many(12, { ms: 40 * MIN, tokens: 240_000 }), { tool: "codex", tier: "standard", repo: "github.com/acme/api", kind: "tests" }, NOW);
  assert.equal(forecastLine(e, { tier: "standard", pct: pctOf(e.tokens, 20_000), tool: "Codex" }), "~35 min · about 12% of your Codex window");
  assert.equal(forecastLine(e, { tier: "standard", pct: pctOf(e.tokens, 20_000), tool: "Codex", whose: "Maya Chen's" }), "~35 min · about 12% of Maya Chen's Codex window");
  // A window that can't be read: time only.
  assert.equal(forecastLine(e, { tier: "standard", pct: pctOf(e.tokens, null), tool: "Cursor" }), "~35 min");
});

// ── burn rate ────────────────────────────────────────────────────────

test("a limit is predicted from the burn rate between readings, and a window that starts over forgets the old ones", () => {
  const b = new BurnTracker();
  b.read("claude|maya|", [{ kind: "five_hour", label: "5h", usedPercent: 40 }], NOW - 10 * MIN);
  b.read("claude|maya|", [{ kind: "five_hour", label: "5h", usedPercent: 50 }], NOW);
  const now = b.burn("claude|maya|", NOW)!;
  assert.equal(Math.round(now.perMin * 10) / 10, 1);
  assert.equal(now.at, NOW + 50 * MIN);
  assert.equal(now.window, "5h");
  // Carried forward: five minutes on, it is about 55% used.
  assert.equal(Math.round(b.burn("claude|maya|", NOW + 5 * MIN)!.used), 55);
  // Started over: lower than before.
  b.read("claude|maya|", [{ kind: "five_hour", label: "5h", usedPercent: 3 }], NOW + 20 * MIN);
  assert.equal(b.burn("claude|maya|", NOW + 20 * MIN)!.at, null);
});

test("readings too close together give no rate; a window that can't be read gives no burn at all", () => {
  const b = new BurnTracker();
  b.read("codex|maya|", [{ kind: "primary", usedPercent: 60 }], NOW - 2 * MIN);
  b.read("codex|maya|", [{ kind: "primary", usedPercent: 64 }], NOW);
  assert.equal(b.burn("codex|maya|", NOW)!.at, null);
  b.read("cursor|maya|", [{ kind: "monthly", usedPercent: null }], NOW);
  assert.equal(b.burn("cursor|maya|", NOW), null);
  assert.equal(b.burn("never|seen|", NOW), null);
});

test("two agents on one plan burn one window: tokens from both count toward what the next reading shows", () => {
  const b = new BurnTracker();
  const key = "claude|maya|";
  b.read(key, [{ kind: "five_hour", usedPercent: 20 }], NOW - 10 * MIN);
  b.spend(key, 60_000); // lane one's turn
  b.spend(key, 40_000); // lane two's turn, same sign-in
  const moved = b.read(key, [{ kind: "five_hour", usedPercent: 25 }], NOW)!;
  assert.deepEqual(moved, { window: "five_hour", pct: 5, tokens: 100_000 });
});

test("a plan's tokens per percent is learnt per person and tool, and one odd reading doesn't swing it", async () => {
  const log = new RunLog(new RedisMock() as unknown as Redis, "t:");
  await log.learnPerPct("ws", "u-maya", "claude", { window: "five_hour", pct: 5, tokens: 100_000 });
  assert.equal(await log.perPct("ws", "u-maya", "claude"), 20_000);
  await log.learnPerPct("ws", "u-maya", "claude", { window: "five_hour", pct: 1, tokens: 80_000 });
  assert.equal(await log.perPct("ws", "u-maya", "claude"), 38_000);
  // Sam's plan is his own: nothing learnt for him from Maya's.
  assert.equal(await log.perPct("ws", "u-sam", "claude"), null);
  assert.deepEqual(await log.perPctOf("ws", "u-maya"), { claude: 38_000 });
});

test("ahead of the limit: when it runs out before the current turn and the next task are done, or the next won't fit", () => {
  const burn = (at: number | null, used = 70): Burn => ({ window: "5h", used, perMin: 1, at });
  const o = { now: NOW, runEndsAt: NOW + 10 * MIN, nextMs: 20 * MIN, nextPct: 10 };
  assert.match(aheadOfLimit(burn(NOW + 25 * MIN), o)!, /heading for its 5h limit in about 25 min, before its next task would be done/);
  assert.equal(aheadOfLimit(burn(NOW + 40 * MIN), o), null);
  assert.match(aheadOfLimit(burn(null, 93), o)!, /has 7% of its 5h limit left, too little for its next task/);
  assert.equal(aheadOfLimit(burn(null, 60), o), null);
  assert.equal(aheadOfLimit(null, o), null);
});

// ── moving the next queued task ──────────────────────────────────────

const laneDef = (id: string, name: string, over: Record<string, unknown> = {}) => ({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" }, ...over } }) as EventBody;
const engine = (over: Partial<LaneEngine>): LaneEngine => ({ tool: "claude", hostId: maya.id, hostName: "Maya Chen", cwd: "/w/api", online: true, sinceSeq: 0, mode: "edits", ...over }) as LaneEngine;

/** Claude Code on `lc` mid-turn on Maya's first message, with `queued` waiting behind it; Codex on `lx`. */
function session(queued: [ActorRef, EventBody][], o: { engines?: Record<string, LaneEngine>; team?: boolean } = {}): [SessionState, SessionEvent[]] {
  const rows: [ActorRef, EventBody, string?][] = [
    [maya, { type: "session.created", title: "t", ownerId: maya.id, ownerName: maya.name }],
    [maya, laneDef("lc", "Claude")],
    [maya, laneDef("lx", "Codex")],
    [maya, { type: "instruction", text: "Refactor the billing module across the codebase.", interrupt: false }, "lc"],
    [tool, { type: "run.started", causedBy: 4 }, "lc"],
    [tool, { type: "instructions.delivered", seqs: [4] }, "lc"],
    ...queued.map(([a, b]) => [a, b, "lc"] as [ActorRef, EventBody, string]),
  ];
  const events = rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: NOW - 5 * MIN, actor, body, ...(lane && lane !== MAIN_LANE ? { lane } : {}) }) as SessionEvent);
  const s = project("s", events);
  const engines = o.engines ?? { lc: engine({}), lx: engine({ tool: "codex" }) };
  return [{ ...s, engines, options: { ...s.options, ...(o.team ? { team: true } : {}) } } as SessionState, events];
}
const next: [ActorRef, EventBody] = [maya, { type: "instruction", text: "Then add tests for the invoice endpoint.", interrupt: false }];
const soon: Burn = { window: "5h", used: 80, perMin: 1, at: NOW + 20 * MIN };
const plenty: Burn = { window: "5h", used: 10, perMin: 0.1, at: null };
const burnOf = (map: Record<string, Burn | null>) => (lane: string) => map[lane] ?? null;

test("a tool heading for its limit has its next queued task planned for the agent best placed to take it", () => {
  const [state, events] = session([next]);
  const plan = planAhead(state, events, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: soon, lx: plenty }) })!;
  assert.equal(plan.seq, 7);
  assert.equal(plan.task, "Then add tests for the invoice endpoint.");
  assert.match(plan.reason, /^Claude Code is heading for its 5h limit/);
  // Codex first (its own subscription, and free); Friday Code, borrowing the machine, after it.
  assert.deepEqual(plan.targets.map((t) => t.id), ["lx", MAIN_LANE]);
});

test("nothing moves with room left, with nothing queued, or for a message meant for the turn under way", () => {
  const [state, events] = session([next]);
  assert.equal(planAhead(state, events, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: plenty, lx: plenty }) }), null);
  const [s2, e2] = session([]);
  assert.equal(planAhead(s2, e2, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: soon }) }), null);
  const [s3, e3] = session([[maya, { type: "instruction", text: "Also keep the old API working", interrupt: true }]]);
  assert.equal(planAhead(s3, e3, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: soon }) }), null);
  // A crew's room: its own hand-off and budgets look after it.
  const [s4, e4] = session([next], { team: true });
  assert.equal(planAhead(s4, e4, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: soon }) }), null);
});

test("never to the same tool on another account, never to someone else's own plan, never to one about to run out too", () => {
  const engines = {
    lc: engine({}),
    // Maya's second Claude account: the same tool, so switching to it is her call, not Friday's.
    lx: engine({ tool: "claude", account: { id: "work", label: "Work" } } as Partial<LaneEngine>),
  };
  const [s1, e1] = session([next], { engines });
  const notLx = (p: ReturnType<typeof planAhead>) => assert.ok(!p!.targets.some((t) => t.id === "lx"), JSON.stringify(p!.targets));
  notLx(planAhead(s1, e1, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: soon }) }));
  // Sam's own Codex plan takes Sam's work only; Maya queued this one.
  const [s2, e2] = session([next], { engines: { lc: engine({}), lx: engine({ tool: "codex", hostId: sam.id, hostName: "Sam Ortiz" }) } });
  notLx(planAhead(s2, e2, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: soon }) }));
  // Every other tool low too: nobody to take it, so it stays queued.
  const [s3, e3] = session([next]);
  notLx(planAhead(s3, e3, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: soon, lx: { window: "5h", used: 97, perMin: 0, at: null } }) }));
  // and with no machine for Friday Code either, nobody: the task stays queued.
  const [s4, e4] = session([next]);
  const noMain = { ...s4, engines: { lc: engine({}), lx: engine({ tool: "codex", online: false }) } } as SessionState;
  assert.deepEqual(planAhead(noMain, e4, "lc", { now: NOW, records: [], perPct: null, burnOf: burnOf({ lc: soon }) })!.targets.filter((t) => t.id !== MAIN_LANE), []);
});

test("moving: the queued message is taken back and handed on with one line saying why, once; the turn under way is untouched", async () => {
  const [state, events] = session([next]);
  const appended: { lane?: string; body: EventBody }[] = [];
  const handed: { to: string; reason: string; task: string }[] = [];
  const seen = new Set<string>();
  const deps = {
    store: {
      state: async () => state,
      events: async () => events,
      append: async (_sid: string, _a: ActorRef, body: EventBody, o: { lane?: string } = {}) => (appended.push({ body, ...(o.lane ? { lane: o.lane } : {}) }), { ok: true }),
    } as never,
    handOff: async (_sid: string, _from: string, req: { to: string; reason: string; task: string }) => (handed.push(req), { ok: true as const, toName: req.to }),
    records: async () => [],
    perPct: async () => null,
    burnOf: (_s: SessionState, l: string) => burnOf({ lc: soon, lx: plenty })(l),
    once: async (k: string) => (seen.has(k) ? false : (seen.add(k), true)),
  };
  assert.equal(await moveAhead(deps, "s", "lc", NOW), true);
  assert.deepEqual(appended, [{ body: { type: "instruction.withdrawn", seq: 7 }, lane: "lc" }]);
  assert.equal(handed.length, 1);
  assert.equal(handed[0]!.to, "lx", "by its lane's id: names needn't be unique");
  assert.equal(handed[0]!.task, "Then add tests for the invoice endpoint.");
  assert.match(handed[0]!.reason, /^Claude Code is heading for its 5h limit in about 20 min, before its next task would be done, so Friday gave it to Codex ahead of time: Codex is free\.$/);
  assert.ok(!appended.some((a) => a.body.type === "run.pause" || a.body.type === "run.cancel"));
  // Once per queued message.
  assert.equal(await moveAhead(deps, "s", "lc", NOW), false);
});

// ── learning from outcomes ───────────────────────────────────────────

test("a run's record: its time, tokens, tier, kind, repo and grade, from the log", () => {
  const events = [
    { seq: 1, ts: NOW - 30 * MIN, actor: maya, body: { type: "instruction", text: "Fix the failing tests in the invoice endpoint", interrupt: false }, lane: "lx" },
    { seq: 2, ts: NOW - 30 * MIN, actor: tool, body: { type: "run.started", causedBy: 1 }, lane: "lx" },
    { seq: 3, ts: NOW - 30 * MIN, actor: tool, body: { type: "instructions.delivered", seqs: [1] }, lane: "lx" },
    { seq: 4, ts: NOW - 5 * MIN, actor: tool, body: { type: "agent.usage", input: 90_000, cached: 500_000, output: 10_000 }, lane: "lx" },
    { seq: 5, ts: NOW, actor: tool, body: { type: "run.ended", outcome: "done" }, lane: "lx" },
  ] as SessionEvent[];
  const s = { ...project("s", events), engines: { lx: engine({ tool: "codex", repo: "acme/api", model: "gpt-6-luna" } as Partial<LaneEngine>) } } as SessionState;
  const r = recordOf(s, events, events[4]!)!;
  assert.equal(r.tool, "codex");
  assert.equal(r.model, "gpt-6-luna");
  assert.equal(r.kind, "tests");
  assert.equal(r.repo, "github.com/acme/api");
  assert.equal(r.ms, 30 * MIN);
  assert.equal(r.tokens, 100_000);
  assert.equal(r.host, maya.id);
  assert.equal(r.grade, 0.8); // done, with no test run seen
  // An account's error teaches nothing about the model.
  assert.equal(recordOf(s, events, { ...events[4]!, body: { type: "run.ended", outcome: "error", error: "You're out of credits" } } as SessionEvent), null);
});

test("what comes after revises a run: a correction, the board's check", () => {
  const events = [
    { seq: 1, ts: NOW, actor: maya, body: { type: "instruction", text: "Fix the cart", interrupt: false } },
    { seq: 2, ts: NOW, actor: tool, body: { type: "run.started", causedBy: 1 } },
    { seq: 3, ts: NOW, actor: tool, body: { type: "run.ended", outcome: "done" } },
    { seq: 4, ts: NOW, actor: maya, body: { type: "instruction", text: "still fails on checkout", interrupt: false } },
    { seq: 5, ts: NOW, actor: tool, body: { type: "board.reviewed", id: "t1", lane: MAIN_LANE, name: "Claude", ok: true, note: "" } },
  ] as SessionEvent[];
  assert.deepEqual(revisionOf(events, events[3]!), { run: `${MAIN_LANE}:3`, grade: 0.25, replace: "min" });
  assert.deepEqual(revisionOf(events, events[4]!), { run: `${MAIN_LANE}:3`, grade: 1, replace: "max" });
  // A run's own end is a record, not a revision.
  assert.equal(revisionOf(events, events[2]!), null);
});

test("a revision reaches the stored record, and the log keeps its cap", async () => {
  const log = new RunLog(new RedisMock() as unknown as Redis, "t2:");
  await log.add("ws", "s:lx:5", rec({ grade: 1 }));
  await log.revise("ws", "s:lx:5", 0.25, "min");
  assert.equal((await log.records("ws"))[0]!.grade, 0.25);
});

test("routing learns per repo and kind of task: outcomes move the odds, measured cost moves the price", () => {
  const records = [...many(12, { tool: "codex", model: "gpt-6-luna", grade: 0.2, cost: 0.4 })];
  const learned = learnedFrom(records, {}, "all", NOW);
  const key = "codex:gpt-6-luna:standard#tests@github.com/acme/api";
  assert.equal(learned[key]!.n, 12);
  const base = fitModels("codex", "standard", [], {}, { repo: "github.com/acme/api", kind: "tests" }).find((f) => f.model === "gpt-6-luna")!;
  const tuned = fitModels("codex", "standard", [], learned, { repo: "github.com/acme/api", kind: "tests" }).find((f) => f.model === "gpt-6-luna")!;
  assert.ok(tuned.success < base.success - 0.2, `${base.success} → ${tuned.success}`);
  assert.ok(tuned.cost > base.cost, `${base.cost} → ${tuned.cost}`);
  // Another kind of task on the same repo is moved by the repo's level only, less.
  const docs = fitModels("codex", "standard", [], learned, { repo: "github.com/acme/api", kind: "docs" }).find((f) => f.model === "gpt-6-luna")!;
  assert.ok(docs.success > tuned.success);
  // The hosted service keeps the workspace and repo levels itself (RouteStats): only the kind level from records.
  assert.deepEqual(Object.keys(learnedFrom(records, {}, "kind", NOW)), [key]);
});

test("what routing learned, in words, and a reset forgets it", () => {
  const records = [
    ...many(5, { tool: "codex", model: "gpt-6-luna", ms: 14 * MIN, cost: 0.05 }),
    ...many(5, { tool: "claude", model: "opus", ms: 20 * MIN, cost: 0.1 }),
    ...many(2, { tool: "claude", model: "opus", kind: "docs" }),
  ];
  const view = learnedView(records, {}, NOW);
  assert.equal(view.length, 1);
  assert.equal(view[0]!.text, "In acme/api, Codex finishes tests 30% faster at half the cost of Claude Code");
  assert.equal(view[0]!.scope, "github.com/acme/api|tests");
  // Reset: everything before it is forgotten for that repo and kind, in the view and in routing.
  const resets = { "github.com/acme/api|tests": NOW };
  assert.deepEqual(learnedView(records, resets, NOW), []);
  assert.equal(learnedFrom(records, resets, "kind", NOW)["codex:gpt-6-luna:standard#tests@github.com/acme/api"], undefined);
  // A reset of everything.
  assert.deepEqual(learnedFrom(records, { "*": NOW }, "all", NOW), {});
});

test("better odds are said as odds; learning from another benchmark table (a model update) is left out", () => {
  const records = [...many(4, { tool: "codex", grade: 0.95 }), ...many(4, { tool: "claude", model: "opus", grade: 0.5 })];
  assert.equal(learnedView(records, {}, NOW)[0]!.text, "In acme/api, Codex gets tests right 95% of the time to Claude Code's 50%");
  const stale = records.map((r) => ({ ...r, asof: "2026-01-01" }));
  assert.deepEqual(learnedView(stale, {}, NOW), []);
  assert.deepEqual(learnedFrom(stale, {}, "all", NOW), {});
});
