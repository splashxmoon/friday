import assert from "node:assert/strict";
import { test } from "node:test";
import { handOnNow, handOnWhy, lastTask, type HandCtx } from "../src/client/ide/hand-on.js";
import { project, type LaneEngine, type SessionState } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/** Arun, 2026-11-20, wave 5: "Hand on to Codex now" on the column's bar: what it sends, in what order, and what it refuses. */
const maya: ActorRef = { id: "u-maya", name: "Maya Chen", kind: "human" };
const tool: ActorRef = { id: "engine", name: "Claude Code", kind: "agent" };
const engine = (over: Partial<LaneEngine>): LaneEngine => ({ tool: "claude", hostId: maya.id, hostName: "Maya Chen", cwd: "/w/api", online: true, sinceSeq: 0, mode: "edits", ...over }) as LaneEngine;

function session(running: boolean, extra: [ActorRef, EventBody, string?][] = []): { state: SessionState; events: SessionEvent[] } {
  const rows: [ActorRef, EventBody, string?][] = [
    [maya, { type: "session.created", title: "t", ownerId: maya.id, ownerName: maya.name }],
    [maya, { type: "instruction", text: "Refactor the billing module.", interrupt: false }],
    [tool, { type: "run.started", causedBy: 2 }],
    ...(running ? [] : [[tool, { type: "run.ended", outcome: "done" } as EventBody] as [ActorRef, EventBody]]),
    ...extra,
  ];
  const events = rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: 1000 + i, actor, body, ...(lane ? { lane } : {}) }) as SessionEvent);
  const s = project("s", events);
  return { state: { ...s, engines: { [MAIN_LANE]: engine({}) } } as SessionState, events };
}

const sent: Record<string, unknown>[] = [];
function ctx(state: SessionState, events: SessionEvent[], o: { onSend?: (c: Record<string, unknown>) => void } = {}): HandCtx {
  return {
    identity: { id: "u-maya", name: "Maya Chen" } as never,
    state,
    events,
    sid: "s",
    invite: "inv",
    send: async (c) => (sent.push(c), o.onSend?.(c), { ok: true }),
  };
}

test("the task is what a person last asked the lane, not a nudge, an approval or an earlier hand-off", () => {
  const { events } = session(true, [
    [maya, { type: "instruction", text: "keep going", interrupt: false, keepGoing: true } as EventBody],
    [maya, { type: "instruction", text: "  ", interrupt: false }],
  ]);
  assert.equal(lastTask(events, MAIN_LANE), "Refactor the billing module.");
  assert.equal(lastTask(events, "nobody"), "");
});

test("a running tool is stopped first, the other tool joins, and the task goes to it with why", async () => {
  sent.length = 0;
  const { state, events } = session(true);
  let live = state;
  const c = ctx(state, events, {
    onSend: (cmd) => {
      // The run ends once cancelled; the new lane is there as soon as it was added.
      if (cmd.type === "run.cancel") live = { ...live, run: { ...live.run, status: "idle" } } as SessionState;
    },
  });
  const get = () => ({ ...c, state: live });
  const connect = (async (o: { tool: string }) => {
    live = { ...live, lanes: [...live.lanes, { id: "lx", name: "Codex" } as never], engines: { ...live.engines, lx: engine({ tool: o.tool as never }) } } as SessionState;
    return { ok: true as const };
  }) as never;
  const r = await handOnNow(get, connect, { from: MAIN_LANE, tool: "codex" });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(sent.map((s) => s.type), ["run.cancel", "instruct"]);
  const hand = sent[1]!;
  assert.equal(hand.lane, "lx");
  assert.equal(hand.text, "Refactor the billing module.");
  assert.deepEqual(hand.handoff, { fromLane: MAIN_LANE, reason: handOnWhy("Claude Code", "Codex"), carried: [] });
  assert.equal(handOnWhy("Claude Code", "Codex"), "Claude Code was heading for its usage limit, so the work moves to Codex before it stops.");
});

test("a tool the session already has takes the work without being brought in again", async () => {
  sent.length = 0;
  const { state, events } = session(false);
  const withLx = { ...state, lanes: [{ id: "lx", name: "Codex" }], engines: { ...state.engines, lx: engine({ tool: "codex" }) } } as unknown as SessionState;
  let connected = 0;
  const r = await handOnNow(() => ctx(withLx, events), (async () => (connected++, { ok: true })) as never, { from: MAIN_LANE, tool: "codex", to: "lx" });
  assert.equal(r.ok, true);
  assert.equal(connected, 0);
  assert.deepEqual(sent.map((s) => s.type), ["instruct"], "nothing running: nothing to stop");
});

test("never to the same tool, never with nothing to hand, and a tool that didn't start leaves the work where it was", async () => {
  sent.length = 0;
  const { state, events } = session(true);
  const never = (async () => assert.fail("not brought in")) as never;
  const same = await handOnNow(() => ctx(state, events), never, { from: MAIN_LANE, tool: "claude" });
  assert.equal(same.ok, false);
  assert.match(same.error!, /sign-ins of one tool/);
  const blank = session(true);
  const empty = await handOnNow(() => ctx(blank.state, blank.events.filter((e) => e.body.type !== "instruction")), never, { from: MAIN_LANE, tool: "codex" });
  assert.match(empty.error!, /no task to hand on/);
  const failed = await handOnNow(() => ctx(state, events), (async () => ({ ok: false, step: 0, error: "not signed in" })) as never, { from: MAIN_LANE, tool: "codex" });
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /Codex didn't start: not signed in/);
  assert.deepEqual(sent, [], "the running tool was not stopped for a tool that never came");
});

test("a second hand-on carries the task the tool was itself handed, and a failed last step says the tool was stopped", async () => {
  const { events } = session(true, [[{ id: "agent", name: "Claude Code", kind: "agent" } as never, { type: "instruction", text: "Carry on with the billing refactor", interrupt: false, handoff: { fromLane: MAIN_LANE, fromName: "Claude Code", toName: "Codex", reason: "r", carried: [] } } as EventBody, "lx"]]);
  assert.equal(lastTask(events, "lx"), "Carry on with the billing refactor");
  const base = session(false);
  const state = { ...base.state, lanes: [{ id: "lx", name: "Codex" }], engines: { ...base.state.engines, lx: engine({ tool: "codex" }) } } as unknown as SessionState;
  const ev = base.events;
  const c = { ...ctx(state, ev), send: async (cmd: Record<string, unknown>) => (cmd.type === "instruct" ? { ok: false, error: "No." } : { ok: true }) } as HandCtx;
  const r = await handOnNow(() => c, (async () => ({ ok: true })) as never, { from: MAIN_LANE, tool: "codex", to: "lx" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /was stopped, so press again/);
});
