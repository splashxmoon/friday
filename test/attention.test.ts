import assert from "node:assert/strict";
import test from "node:test";
import { attentionFor, attentionIn, sortAttention, type Attention } from "../src/attention.js";
import { apply, type SessionState } from "../src/session/projection.js";
import type { SessionEvent } from "../src/types.js";

/**
 * What is allowed to interrupt somebody.
 *
 * This decides what shows in the sidebar and what raises a desktop
 * notification, so the rules that matter are the refusals: a question for
 * somebody else is not yours, a control request you cannot grant is not
 * yours, and no session gets to make two claims on your attention at once.
 */

const ME = "u-me";

const session = (over: Partial<SessionState> = {}): SessionState =>
  ({
    id: "s1",
    title: "Ship the checkout flow",
    ownerId: ME,
    workspaceId: "w1",
    lastSeq: 40,
    members: { [ME]: { name: "Me", role: "owner" }, "u-maya": { name: "Maya", role: "editor" } },
    driver: { id: ME, name: "Me" },
    pendingRequests: [],
    run: { status: "idle", sinceSeq: 0 },
    openQuestions: {},
    // Every real state has these; a fixture without them was only ever
    // exercising the questions that don't look at lanes.
    lanes: [],
    laneRuns: {},
    laneDrivers: {},
    approvals: {},
    asks: {},
    engines: {},
    options: { agent: null },
    ...over,
  }) as unknown as SessionState;

const question = (to: string, seq = 12, lane = "main") => ({ [lane]: { seq, lane, question: "Merge the carts, or replace?", to, toName: "Me" } });

test("a question asked of you is the strongest claim there is", () => {
  const a = attentionFor(session({ openQuestions: question(ME) }), ME)!;
  assert.equal(a.kind, "question");
  assert.equal(a.text, "Merge the carts, or replace?");
  assert.equal(a.seq, 12);
});

test("a question asked of somebody else is not yours", () => {
  assert.equal(attentionFor(session({ openQuestions: question("u-maya") }), ME), null);
});

test("two agents asking at once are two lines, each for the person it asked", () => {
  const lanes = [{ id: "l1", name: "Reviewer" }];
  const both = { ...question(ME, 12), ...question(ME, 15, "l1") };
  assert.deepEqual(attentionIn(session({ lanes, openQuestions: both } as Partial<SessionState>), ME).filter((a) => a.kind === "question").map((a) => [a.lane, a.seq]), [["l1", 15], ["main", 12]]);
  // The reviewer's question is Maya's: it is hers to answer, and the main one stays yours.
  const split = { ...question(ME, 12), ...question("u-maya", 15, "l1") };
  assert.deepEqual(attentionIn(session({ lanes, openQuestions: split } as Partial<SessionState>), ME).filter((a) => a.kind === "question").map((a) => a.lane), ["main"]);
  assert.deepEqual(attentionIn(session({ lanes, openQuestions: split } as Partial<SessionState>), "u-maya").filter((a) => a.kind === "question").map((a) => a.lane), ["l1"]);
});

test("someone wanting the wheel counts only while you are holding it", () => {
  const pending = [{ id: "u-maya", name: "Maya", seq: 20, lane: "main" }];
  assert.equal(attentionFor(session({ pendingRequests: pending }), ME)!.kind, "control");
  // Not driving: it is a real request, but not one you can answer.
  assert.equal(attentionFor(session({ pendingRequests: pending, driver: { id: "u-maya", name: "Maya" } }), ME), null);
});

test("several people waiting is said once, with a number", () => {
  const a = attentionFor(
    session({
      pendingRequests: [
        { id: "u-maya", name: "Maya", seq: 20, lane: "main" },
        { id: "u-sam", name: "Sam", seq: 21, lane: "main" },
        { id: "u-theo", name: "Theo", seq: 22, lane: "main" },
      ],
    }),
    ME,
  )!;
  assert.equal(a.text, "Maya and 2 others want control");
});

/** "Maya and 1 other" is a compound subject, so the verb stays plural. */
test("one other person is one other, not 1 others", () => {
  const a = attentionFor(
    session({
      pendingRequests: [
        { id: "u-maya", name: "Maya", seq: 20, lane: "main" },
        { id: "u-sam", name: "Sam", seq: 21, lane: "main" },
      ],
    }),
    ME,
  )!;
  assert.equal(a.text, "Maya and 1 other want control");
});

test("a stopped run is yours only if you can restart it", () => {
  const stopped = { status: "error" as const, sinceSeq: 30, error: "The folder disconnected." };
  assert.equal(attentionFor(session({ run: stopped }), ME)!.kind, "stopped");
  assert.equal(attentionFor(session({ run: stopped, driver: { id: "u-maya", name: "Maya" } }), ME), null);
  // A coding tool out on its usage limit is handed on and comes back by itself: nothing for you to do, so no card.
  const limited = { status: "error" as const, sinceSeq: 31, error: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours." };
  assert.equal(attentionFor(session({ run: limited }), ME), null);
  const claude = { status: "error" as const, sinceSeq: 32, error: "Claude AI usage limit reached|1760000000" };
  assert.equal(attentionFor(session({ run: claude }), ME), null);
  // A tool's raw error is said in words where it is listed, and kept as the detail (Arun, 2026-10-29).
  const crashed = attentionFor(session({ run: { status: "error" as const, sinceSeq: 33, error: "node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module 'x'" } }), ME)!;
  assert.equal(crashed.text, "Stopped: their tool failed to start");
  assert.match(crashed.detail ?? "", /cjs\/loader/);
  assert.equal(attentionFor(session({ run: stopped }), ME)!.detail, undefined);
});

/**
 * One line per session. Three reasons at once is three rows for one place you
 * have to go, and a list long enough to scroll is a list nobody reads.
 */
test("a session makes one claim at a time, the most blocking one", () => {
  const a = attentionFor(
    session({
      openQuestions: question(ME),
      pendingRequests: [{ id: "u-maya", name: "Maya", seq: 20, lane: "main" }],
      run: { status: "error", sinceSeq: 30, error: "stopped" },
    }),
    ME,
  )!;
  assert.equal(a.kind, "question");
});

test("a quiet session says nothing", () => {
  assert.equal(attentionFor(session(), ME), null);
});

test("questions first, then control, then what already stopped", () => {
  const mk = (kind: Attention["kind"], seq: number): Attention => ({ sid: `s${seq}`, title: "t", kind, text: "x", seq });
  const order = sortAttention([mk("stopped", 1), mk("control", 2), mk("question", 3), mk("question", 9)]).map((a) => `${a.kind}:${a.seq}`);
  // Within a kind, the newest is the one somebody is standing next to.
  assert.deepEqual(order, ["question:9", "question:3", "control:2", "stopped:1"]);
});

import { workingIn } from "../src/attention.js";

/**
 * Which sessions are actually doing something.
 *
 * Every row in the session list read the same whether an agent had been
 * running in it for ten minutes or nobody had touched it since Tuesday. The
 * log knows — a run is running or it is not — and the poll that asks what
 * needs you already reads every recent session's state, so this rides along
 * with it rather than costing a second pass.
 */
test("a session with a run going says so, and a quiet one says nothing", () => {
  assert.equal(workingIn(session()), null);
  const busy = workingIn(session({ run: { status: "running", sinceSeq: 5 } }))!;
  assert.equal(busy.lanes, 1);
  assert.equal(busy.what, "Main");
});

/** Several agents at once is the thing this product is for, so it reads as several. */
test("lanes running are counted and named", () => {
  const busy = workingIn(
    session({
      run: { status: "running", sinceSeq: 5 },
      lanes: [{ id: "l1", name: "Reviewer" }, { id: "l2", name: "Tests" }],
      laneRuns: { l1: { status: "running", sinceSeq: 6 }, l2: { status: "idle", sinceSeq: 2 } },
    } as unknown as Partial<SessionState>),
  )!;
  assert.equal(busy.lanes, 2, "main and the reviewer, not the idle one");
  assert.equal(busy.what, "Main, Reviewer");
});

/** A lane that is running but no longer in the list still counts as work. */
test("a run in a lane nobody can name is still a run", () => {
  const busy = workingIn(session({ lanes: [], laneRuns: { gone: { status: "running", sinceSeq: 9 } } } as unknown as Partial<SessionState>))!;
  assert.equal(busy.what, "a lane");
});

test("paused and waiting are not working", () => {
  assert.equal(workingIn(session({ run: { status: "paused", sinceSeq: 3 } })), null);
  assert.equal(workingIn(session({ run: { status: "waiting_for_human", sinceSeq: 3 } })), null);
});

// ── waiting on you, an agent at a time ──

const lane = (id: string, name: string) => ({ id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } });

test("a coding tool asking before it runs something is waiting on whoever drives it, and says what it wants to run", () => {
  const s = session({
    lanes: [lane("cc", "Claude Code")],
    laneDrivers: { cc: { id: ME, name: "Me" } },
    approvals: { cc: { id: "k1", seq: 30, tool: "claude", scope: "commands", items: ["npm install left-pad", "npm test"] } },
  } as Partial<SessionState>);
  const [a] = attentionIn(s, ME);
  assert.deepEqual([a!.kind, a!.lane, a!.agent, a!.approval], ["approval", "cc", "Claude Code", "k1"]);
  assert.equal(a!.text, "Claude Code wants to run `npm install left-pad` and 1 more");
  assert.equal(a!.command, true, "a command: the sidebar answers it with Run it, as the card does");
  assert.deepEqual(attentionIn(s, "u-maya"), [], "not every editor's: the driver's");
});

test("nobody driving: a permission request is the owner's", () => {
  const s = session({ driver: null, approvals: { main: { id: "k2", seq: 31, scope: "turn", items: [] } } } as Partial<SessionState>);
  assert.equal(attentionIn(s, ME)[0]!.text, "Friday Code is asking before it goes on");
  assert.deepEqual(attentionIn(s, "u-maya"), []);
});

test("each blocked agent is its own line, the ones holding up work first", () => {
  const s = session({
    lanes: [lane("rv", "Reviewer"), lane("cx", "Codex")],
    laneDrivers: { rv: { id: ME, name: "Me" }, cx: { id: ME, name: "Me" } },
    laneRuns: { rv: { status: "error", sinceSeq: 20, error: "Model exploded" } },
    approvals: { cx: { id: "k3", seq: 25, scope: "commands", items: ["rm -rf dist"] } },
  } as Partial<SessionState>);
  const all = attentionIn(s, ME);
  assert.deepEqual(all.map((a) => `${a.kind}:${a.agent}`), ["approval:Codex", "stopped:Reviewer"]);
  assert.equal(attentionFor(s, ME)!.kind, "approval", "the session's one line is still its worst");
});

// ── a coding tool that ended its turn asking ──

/**
 * Claude Code and Codex have no ask_human: they end the turn with the question in the answer. The projection reads it off
 * that answer, and it waits on whoever drives the lane until the lane gets its next instruction or starts again.
 */
const ASKING = "Before I plan further:\n[1] What's the primary goal right now?\n- a. **Model accuracy** — a new sweep\n- b. **Generalisation** — the holdout\n(Answering \"1=a\" is enough.)";
const ev = (seq: number, body: Record<string, unknown>, laneId = "cc") => ({ seq, ts: seq, lane: laneId, actor: { kind: "agent", id: "a", name: "Claude Code" }, body }) as unknown as SessionEvent;
const engineLane = (over: Partial<SessionState> = {}) =>
  session({
    lanes: [lane("cc", "Claude Code")],
    laneDrivers: { cc: { id: ME, name: "Me" } },
    laneRuns: { cc: { status: "running", sinceSeq: 40 } },
    lanePending: { cc: [] },
    engines: { cc: { tool: "claude", hostId: "h", hostName: "Laptop", cwd: "/repo", mode: "edits", online: true, sinceSeq: 1 } },
    planReviews: {},
    resumes: {},
    ...over,
  } as unknown as Partial<SessionState>);

test("a coding tool's answer that ends on a question waits on its driver once the run is over", () => {
  const s = engineLane();
  apply(s, ev(41, { type: "agent.message", text: ASKING, toolCalls: [] }));
  assert.deepEqual(attentionIn(s, ME), [], "not while it is still running");
  apply(s, ev(42, { type: "run.ended", outcome: "done" }));
  const [a] = attentionIn(s, ME);
  assert.deepEqual([a!.kind, a!.lane, a!.agent, a!.seq, a!.text], ["ask", "cc", "Claude Code", 41, "What's the primary goal right now?"]);
  assert.deepEqual(attentionIn(s, "u-maya"), [], "the driver's to answer, not every editor's");
});

test("the next instruction or run on that lane ends the wait", () => {
  const s = engineLane();
  apply(s, ev(41, { type: "agent.message", text: ASKING, toolCalls: [] }));
  apply(s, ev(42, { type: "run.ended", outcome: "done" }));
  apply(s, { ...ev(43, { type: "instruction", text: "1=b (Generalisation)" }), actor: { kind: "human", id: ME, name: "Me" } } as SessionEvent);
  assert.deepEqual(attentionIn(s, ME), []);
  apply(s, ev(44, { type: "agent.message", text: ASKING, toolCalls: [] }));
  apply(s, ev(45, { type: "run.started" }));
  assert.deepEqual(attentionIn(s, ME), [], "started again by itself");
});

test("an answer that asks nothing, or goes on working, is not waiting on anyone", () => {
  const s = engineLane();
  apply(s, ev(41, { type: "agent.message", text: ASKING, toolCalls: [] }));
  apply(s, ev(42, { type: "agent.message", text: "Actually, I'll look at the data first.", toolCalls: [{ id: "t", name: "Read", arguments: "{}" }] }));
  apply(s, ev(43, { type: "agent.message", text: "Done: the sweep is set up. Let me know if you want more.", toolCalls: [] }));
  apply(s, ev(44, { type: "run.ended", outcome: "done" }));
  assert.deepEqual(attentionIn(s, ME), []);
});

test("Friday's own agent asks with ask_human, so its prose is not read for questions", () => {
  const s = engineLane({ engines: {} } as Partial<SessionState>);
  apply(s, ev(41, { type: "agent.message", text: ASKING, toolCalls: [] }));
  apply(s, ev(42, { type: "run.ended", outcome: "done" }));
  assert.deepEqual(attentionIn(s, ME), []);
});

test("several questions are said as the first and how many more", () => {
  const s = engineLane({ laneRuns: { cc: { status: "idle", sinceSeq: 40 } } } as Partial<SessionState>);
  apply(s, ev(41, { type: "agent.message", text: "[1] Which port?\n- a) 3000\n- b) 8080\n[2] Which host?\n[3] Which user?", toolCalls: [] }));
  apply(s, ev(42, { type: "run.ended", outcome: "done" }));
  assert.equal(attentionIn(s, ME)[0]!.text, "Which port? (and 2 more)");
});
