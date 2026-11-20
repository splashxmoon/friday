import assert from "node:assert/strict";
import test from "node:test";
import type { Burn } from "../src/forecast.js";
import { autoPick, fullestOf, handedOnLine, limitBar, outBar, windowWords, type HandTarget } from "../src/ide-routing.js";
import { planOf, taskRouting, toolLane } from "../src/ide-routing-task.js";
import type { ToolOption } from "../src/routing.js";
import { project, type LaneEngine, type SessionState } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/** Arun, 2026-11-20, wave 5: usage-aware routing in Code. The Auto pick and the column's bar, from the numbers alone. */

const NOW = Date.UTC(2026, 10, 20, 15);
const MIN = 60_000;
const maya: ActorRef = { id: "u-maya", name: "Maya Chen", kind: "human" };
const tool: ActorRef = { id: "engine", name: "Claude Code", kind: "agent" };

const five = (used: number, resetsAt: number | null = null) => ({ kind: "five_hour", label: "5h", usedPercent: used, resetsAt });
const opt = (t: ToolOption["tool"], used: number | null, ready = true): ToolOption => ({ tool: t, ready, fullest: used, windows: used === null ? [] : [five(used)] });

// ── Auto ─────────────────────────────────────────────────────────────

test("Auto: the usual tool is passed over when its window is nearly spent, and the line says which and how full", () => {
  const p = autoPick({ ready: [opt("claude", 92), opt("codex", 20)], usual: "claude", text: "Add input validation to the signup form", now: NOW })!;
  assert.equal(p.tool, "codex");
  assert.equal(p.why, "Codex: Claude Code is at 92% of its 5-hour window");
});

test("Auto: with room on both, the person's usual tool stays unless another has clearly more", () => {
  const near = autoPick({ ready: [opt("claude", 40), opt("codex", 35)], usual: "claude", text: "Fix the failing date parser test", now: NOW })!;
  assert.equal(near.tool, "claude", "5 points apart is not worth changing for");
  const far = autoPick({ ready: [opt("claude", 70), opt("codex", 5)], usual: "claude", text: "Fix the failing date parser test", now: NOW })!;
  assert.equal(far.tool, "codex");
  assert.match(far.why, /^Codex: Claude Code is at 70% of its 5-hour window$/);
});

test("Auto: with no usual tool it takes the one with the most room, and says how much is left", () => {
  const p = autoPick({ ready: [opt("claude", 60), opt("codex", 10)], text: "Rename the config loader and update callers", now: NOW })!;
  assert.equal(p.tool, "codex");
  assert.equal(p.why, "Codex: 90% of its 5-hour window left, the most room you have");
});

test("Auto: a tool nobody has read is not compared, so the line only says how much is left", () => {
  const p = autoPick({ ready: [opt("claude", 12), opt("codex", null)], usual: "claude", text: "Fix the build", now: NOW })!;
  assert.equal(p.tool, "claude");
  assert.equal(p.why, "Claude Code: 88% of its 5-hour window left");
});

test("Auto: a tool at its limit or not signed in is never picked; one tool alone is said to be the only one", () => {
  const p = autoPick({ ready: [opt("claude", 100), opt("codex", 50), opt("cursor", 30, false)], usual: "claude", text: "Fix the build", now: NOW })!;
  assert.equal(p.tool, "codex");
  const only = autoPick({ ready: [opt("claude", 30)], text: "Fix the build", now: NOW })!;
  assert.equal(only.why, "Claude Code: the only tool ready here");
  assert.match(autoPick({ ready: [opt("claude", 100)], text: "Fix the build", now: NOW })!.why, /Every tool is at its limit/);
  assert.equal(autoPick({ ready: [], now: NOW }), null);
});

test("Auto: with no usage numbers yet it keeps the usual tool and says so rather than inventing a figure", () => {
  const p = autoPick({ ready: [opt("claude", null), opt("codex", null)], usual: "codex", text: "Fix the build", now: NOW })!;
  assert.equal(p.tool, "codex");
  assert.match(p.why, /^Codex: no usage numbers yet/);
});

test("Auto: a window about to start over counts as free", () => {
  const soon = { tool: "claude" as const, ready: true, fullest: 80, windows: [five(80, Math.floor((NOW + 10 * MIN) / 1000))] };
  const p = autoPick({ ready: [soon, opt("codex", 60)], usual: "claude", text: "Fix the failing date parser test", now: NOW })!;
  assert.equal(p.tool, "claude");
});

test("window names read as people say them", () => {
  assert.equal(windowWords("5h"), "5-hour window");
  assert.equal(windowWords("five_hour"), "5-hour window");
  assert.equal(windowWords("Weekly"), "weekly limit");
  assert.equal(windowWords(undefined), "limit");
  assert.equal(windowWords("Session", "five_hour"), "5-hour window", "Claude Code calls its five hours the session");
  assert.equal(windowWords("Session"), "5-hour window");
  assert.equal(windowWords("Weekly · Opus", "seven_day_opus"), "weekly limit");
  assert.equal(windowWords("Chat"), "Chat limit");
  assert.deepEqual(fullestOf([five(30), { kind: "seven_day", label: "Weekly", usedPercent: 71.4 }]), { used: 71, words: "weekly limit" });
  assert.equal(fullestOf([]), null);
});

// ── the column's bar ─────────────────────────────────────────────────

const to: HandTarget[] = [{ tool: "codex", name: "Codex" }];
const heading: Burn = { window: "5h", used: 80, perMin: 1, at: NOW + 20 * MIN };
const base = { tool: "claude" as const, running: true, now: NOW, burn: heading, runEndsAt: NOW + 30 * MIN, targets: to };

test("bar: a tool at work, heading for its limit before its turn is done, with someone to take it", () => {
  const b = limitBar(base)!;
  assert.equal(b.text, "Claude Code: limit in ~20 min");
  assert.equal(b.full, "Claude Code may hit its limit in ~20 min");
  assert.equal(b.window, "5-hour window");
  assert.equal(b.inMs, 20 * MIN);
  assert.deepEqual(b.to, to);
});

test("bar: not shown when it would last past the turn, or the limit is more than an hour away", () => {
  assert.equal(limitBar({ ...base, runEndsAt: NOW + 10 * MIN }), null);
  assert.equal(limitBar({ ...base, burn: { ...heading, at: NOW + 90 * MIN }, runEndsAt: NOW + 3 * 3_600_000 }), null);
  assert.equal(limitBar({ ...base, burn: { ...heading, at: null, used: 40 } }), null);
  assert.equal(limitBar({ ...base, burn: { ...heading, at: NOW - MIN } }), null, "a time already past is not a prediction");
});

test("bar: nearly full and not moving still says so, in what is left", () => {
  const b = limitBar({ ...base, burn: { window: "5h", used: 97, perMin: 0, at: null } })!;
  assert.equal(b.text, "Claude Code: 3% left");
  assert.equal(b.full, "Claude Code has 3% of its 5-hour window left");
  assert.equal(b.inMs, null);
  assert.equal(limitBar({ ...base, burn: { window: "5h", used: 100, perMin: 0, at: null } }), null, "at the limit it is the hand-on's to say");
});

test("bar: nothing while idle, in a crew's room, once handed on, once limited, with no reading, or with nobody to take it", () => {
  assert.equal(limitBar({ ...base, running: false }), null);
  assert.equal(limitBar({ ...base, team: true }), null);
  assert.equal(limitBar({ ...base, handedOn: true }), null);
  assert.equal(limitBar({ ...base, limited: true }), null);
  assert.equal(limitBar({ ...base, burn: null }), null);
  assert.equal(limitBar({ ...base, targets: [] }), null);
  assert.equal(limitBar({ ...base, tool: undefined }), null);
});

test("the hand-on line says who ran out and who carried on", () => {
  assert.equal(handedOnLine({ from: "Claude Code", to: "Codex", auto: true }), "Claude Code ran out of usage. Friday handed the work to Codex, which carried on.");
  assert.equal(handedOnLine({ from: "Claude Code", to: "Codex", auto: false }), "Claude Code ran out of usage. Codex carried on.");
});

// ── read off a session ───────────────────────────────────────────────

const laneDef = (id: string, name: string) => ({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } }) as EventBody;
const engine = (over: Partial<LaneEngine>): LaneEngine => ({ tool: "claude", hostId: maya.id, hostName: "Maya Chen", cwd: "/w/api", online: true, sinceSeq: 0, mode: "edits", ...over }) as LaneEngine;

function session(tail: [ActorRef, EventBody, string?][], o: { team?: boolean; engines?: Record<string, LaneEngine> } = {}): [SessionState, SessionEvent[]] {
  const rows: [ActorRef, EventBody, string?][] = [
    [maya, { type: "session.created", title: "t", ownerId: maya.id, ownerName: maya.name }],
    [maya, laneDef("lx", "Codex")],
    [maya, { type: "instruction", text: "Refactor the billing module across the codebase.", interrupt: false }],
    [tool, { type: "run.started", causedBy: 3 }],
    [tool, { type: "instructions.delivered", seqs: [3] }],
    ...tail,
  ];
  const events = rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: NOW - 5 * MIN + i, actor, body, ...(lane && lane !== MAIN_LANE ? { lane } : {}) }) as SessionEvent);
  const s = project("s", events);
  const engines = o.engines ?? { [MAIN_LANE]: engine({}), lx: engine({ tool: "codex" }) };
  return [{ ...s, engines, options: { ...s.options, ...(o.team ? { team: true } : {}) } } as SessionState, events];
}
const deps = (burn: Burn | null, options: ToolOption[] = [opt("codex", 10)]) => ({ now: NOW, windows: () => [five(88)], burnOf: () => burn, records: async () => [], options: async () => options });

test("a running chat heading for its limit gets the bar, naming the tool that has room and the lane it already has", async () => {
  const [state, events] = session([]);
  assert.equal(toolLane(state), MAIN_LANE);
  const r = await taskRouting(state, events, deps(heading));
  assert.equal(r.plan?.left, 12);
  assert.equal(r.plan?.name, "Claude Code");
  assert.equal(r.bar?.text, "Claude Code: limit in ~20 min");
  assert.deepEqual(r.bar?.to, [{ tool: "codex", name: "Codex", lane: "lx" }]);
  assert.equal(r.handed, undefined);
});

test("never the same tool on another sign-in, and never a tool that is itself nearly out", async () => {
  const [state, events] = session([]);
  const r = await taskRouting(state, events, deps(heading, [opt("claude", 5), opt("codex", 97)]));
  assert.equal(r.bar, undefined, "Claude is the one running; Codex has nothing left");
  const ok = await taskRouting(state, events, deps(heading, [opt("claude", 5), opt("codex", 40)]));
  assert.deepEqual(ok.bar?.to.map((t) => t.tool), ["codex"]);
});

test("no bar with a plenty-of-room tool, with nothing running, or in a crew's room; the plan figure is still there", async () => {
  const plenty: Burn = { window: "5h", used: 10, perMin: 0.1, at: null };
  const [state, events] = session([]);
  assert.equal((await taskRouting(state, events, deps(plenty))).bar, undefined);
  const [idle, ie] = session([[tool, { type: "run.ended", outcome: "done" } as EventBody]]);
  const r = await taskRouting(idle, ie, deps(heading));
  assert.equal(r.bar, undefined);
  assert.equal(r.plan?.left, 12);
  const [team, te] = session([], { team: true });
  assert.equal((await taskRouting(team, te, deps(heading))).bar, undefined);
});

test("the options are asked of the computer only when a bar may show", async () => {
  const [state, events] = session([]);
  let asked = 0;
  const d = { ...deps({ window: "5h", used: 10, perMin: 0, at: null }), options: async () => (asked++, [opt("codex", 10)]) };
  await taskRouting(state, events, d);
  assert.equal(asked, 0);
  await taskRouting(state, events, { ...d, burnOf: () => heading });
  assert.equal(asked, 1);
});

test("a tool that ran out and had its work handed on: the column says who carried on, and the bar is gone", async () => {
  const handoff = { fromLane: MAIN_LANE, fromName: "Claude Code", toName: "Codex", reason: "ran out", carried: [] };
  const [state, events] = session([
    [tool, { type: "run.ended", outcome: "error", error: "You've hit your usage limit. Your limit resets at 8pm." } as EventBody],
    [{ id: "agent", name: "Claude Code", kind: "agent" }, { type: "instruction", text: "Carry on with the refactor", interrupt: false, handoff } as EventBody, "lx"],
  ]);
  const r = await taskRouting(state, events, deps(heading));
  assert.equal(r.handed?.text, "Claude Code ran out of usage. Friday handed the work to Codex, which carried on.");
  assert.equal(r.bar, undefined);
  // The same hand-on pressed by the person says it without Friday in it.
  const byMaya = events.map((e) => (e.body.type === "instruction" && e.body.handoff ? { ...e, actor: maya } : e));
  assert.equal((await taskRouting(state, byMaya, deps(heading))).handed?.text, "Claude Code ran out of usage. Codex carried on.");
});

// ── the 2026-11-20 review ─────────────────────────────────────────────

const handoff = { fromLane: MAIN_LANE, fromName: "Claude Code", toName: "Codex", reason: "ran out", carried: [] };
const limitEnd = [tool, { type: "run.ended", outcome: "error", error: "You've hit your usage limit. Your limit resets at 8pm." } as EventBody] as [ActorRef, EventBody];
const agentCodex: ActorRef = { id: "agent", name: "Claude Code", kind: "agent" };
const handOn = [agentCodex, { type: "instruction", text: "Carry on with the refactor", interrupt: false, handoff } as EventBody, "lx"] as [ActorRef, EventBody, string];

test("the hand-on line shows while the tool that took the work is running, not only after it finished", async () => {
  const [state, events] = session([limitEnd, handOn, [tool, { type: "run.started", causedBy: 6 } as EventBody, "lx"]]);
  assert.equal(toolLane(state), "lx", "Codex is the one at work");
  const r = await taskRouting(state, events, deps(null));
  assert.equal(r.handed?.text, "Claude Code ran out of usage. Friday handed the work to Codex, which carried on.");
  assert.equal(r.lane, "lx");
  assert.equal(r.bar, undefined);
});

test("with the work handed on and Codex not started yet, or finished, the plan is Codex's window, not Claude Code's", async () => {
  const win = (lane: string) => [five(lane === "lx" ? 40 : 88)];
  const d = { ...deps(null), windows: win };
  const [waiting, we] = session([limitEnd, handOn]);
  const a = await taskRouting(waiting, we, d);
  assert.deepEqual([a.lane, a.plan?.name, a.plan?.left], ["lx", "Codex", 60]);
  const [done, de] = session([limitEnd, handOn, [tool, { type: "run.started", causedBy: 6 } as EventBody, "lx"], [tool, { type: "run.ended", outcome: "done" } as EventBody, "lx"]]);
  assert.equal(toolLane(done), "lx", "the one that worked last");
  const b = await taskRouting(done, de, d);
  assert.deepEqual([b.lane, b.plan?.name, b.plan?.left], ["lx", "Codex", 60]);
  assert.equal(planOf(done, win).plan?.name, "Codex", "from the state alone, as the task list reads it");
});

test("a chat that is idle reads no log: the events are asked for only with a tool at work or a run that ended in error", async () => {
  let reads = 0;
  const log = async () => (reads++, []);
  const [idle] = session([[tool, { type: "run.ended", outcome: "done" } as EventBody]]);
  const r = await taskRouting(idle, log, deps(heading));
  assert.equal(reads, 0);
  assert.equal(r.plan?.left, 12);
  const [busy] = session([]);
  await taskRouting(busy, log, deps(null));
  assert.equal(reads, 1);
  const [failed] = session([limitEnd]);
  await taskRouting(failed, log, deps(null));
  assert.equal(reads, 2);
});

test("a chat with one tool that hit its limit keeps a bar offering the hand-on, until the work has gone on", async () => {
  const solo = { [MAIN_LANE]: engine({}) };
  const [state, events] = session([limitEnd], { engines: solo });
  const r = await taskRouting(state, events, deps(null));
  assert.equal(r.bar?.out, true);
  assert.equal(r.bar?.text, "Claude Code ran out of usage");
  assert.deepEqual(r.bar?.to.map((t) => t.tool), ["codex"]);
  assert.equal(r.handed, undefined);
  // Not the same tool, not a tool with nothing left, not in a crew's room.
  assert.equal((await taskRouting(state, events, deps(null, [opt("claude", 5)]))).bar, undefined);
  assert.equal((await taskRouting(state, events, deps(null, [opt("codex", 99)]))).bar, undefined);
  const [team, te] = session([limitEnd], { engines: solo, team: true });
  assert.equal((await taskRouting(team, te, deps(null))).bar, undefined);
  assert.equal(outBar({ tool: "claude", handedOn: true, targets: to }), null);
  assert.equal(outBar({ tool: "claude", targets: [] }), null);
  // Handed on (a person's own pass): the line, no bar.
  const [gone, ge] = session([limitEnd, handOn], { engines: { ...solo, lx: engine({ tool: "codex" }) } });
  const g = await taskRouting(gone, ge, deps(null));
  assert.equal(g.bar, undefined);
  assert.ok(g.handed);
});

test("Auto: the line names a tool that is ready but out of room, not 'the only tool ready'", () => {
  const p = autoPick({ ready: [opt("claude", 95), opt("codex", 60)], usual: "codex", now: NOW })!;
  assert.equal(p.tool, "codex");
  assert.equal(p.why, "Codex: Claude Code is at 95% of its 5-hour window");
  const lone = autoPick({ ready: [opt("claude", 30)], now: NOW })!;
  assert.match(lone.why, /the only tool ready here/);
});

test("Auto: every tool at its limit keeps the person's tool and says so", () => {
  const p = autoPick({ ready: [opt("claude", 100), opt("codex", 100)], usual: "codex", now: NOW })!;
  assert.equal(p.tool, "codex");
  assert.match(p.why, /Every tool is at its limit/);
  assert.equal(autoPick({ ready: [], now: NOW }), null);
});

test("Auto: a usual tool past 80% gives way to one nobody has read; below that it stays", () => {
  const spent = autoPick({ ready: [opt("claude", 88), opt("codex", null)], usual: "claude", now: NOW })!;
  assert.equal(spent.tool, "codex");
  assert.equal(spent.why, "Codex: Claude Code is at 88% of its 5-hour window");
  const fine = autoPick({ ready: [opt("claude", 60), opt("codex", null)], usual: "claude", now: NOW })!;
  assert.equal(fine.tool, "claude");
});
