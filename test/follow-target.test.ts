import assert from "node:assert/strict";
import test from "node:test";
import { followTarget, PICKED_HOLD_MS } from "../src/client/follow-target.js";
import { project } from "../src/session/projection.js";
import { MAIN_LANE, type EventBody, type SessionEvent } from "../src/types.js";

/** The message box following the work: to whoever took it over, asked, or is waiting; never over someone typing or choosing. */

const ada = { id: "ada", name: "Ada", kind: "human" as const };
let seq = 0;
const ev = (actor: SessionEvent["actor"], body: EventBody, lane?: string): SessionEvent => ({ seq: ++seq, ts: Date.now(), actor, body, ...(lane ? { lane } : {}) });
const codexBot = { id: "engine:h1:codex", name: "Ada's Codex", kind: "agent" as const };
const kiroBot = { id: "engine:h1:kiro", name: "Ada's Kiro", kind: "agent" as const };

function room() {
  seq = 0;
  const lane = (id: string, name: string) => ({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } }) as EventBody;
  const base = [
    ev(ada, { type: "session.created", title: "Model", ownerId: "ada", ownerName: "Ada", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody),
    ev(ada, lane("codex", "Codex")),
    ev(ada, lane("kiro", "Kiro")),
    ev(ada, { type: "control.granted", to: "ada", toName: "Ada", reason: "claim" }, "codex"),
    ev(ada, { type: "control.granted", to: "ada", toName: "Ada", reason: "claim" }, "kiro"),
  ];
  return base;
}

const look = (events: SessionEvent[], fresh: SessionEvent[], over: Partial<Parameters<typeof followTarget>[0]> = {}) =>
  followTarget({
    target: "codex",
    me: "ada",
    state: project("s", [...events, ...fresh]),
    fresh,
    typing: false,
    pickedAt: 0,
    now: Date.now(),
    mayWrite: () => true,
    name: (l) => (l === MAIN_LANE ? "Friday Code" : l === "codex" ? "Codex" : "Kiro"),
    ...over,
  });

const handoff = () =>
  ev(ada, { type: "instruction", text: "Pick up from Codex's work and carry on.", interrupt: false, handoff: { fromLane: "codex", fromName: "Codex", toName: "Kiro", reason: "Codex finished its part.", carried: [] } }, "kiro");

test("a handoff from the agent being written to moves the box to the one that took over, and says so", () => {
  const events = room();
  const f = look(events, [handoff()]);
  assert.deepEqual(f, { lane: "kiro", why: "Writing to Kiro: it took over from Codex." });
});

test("an agent asking you something moves the box to it; asking someone else doesn't", () => {
  const events = room();
  const ask = (to: string) => ev(kiroBot, { type: "agent.question", callId: "q1", question: "Which goal?", to, toName: to } as EventBody, "kiro");
  assert.equal(look(events, [ask("ada")])?.lane, "kiro");
  assert.equal(look(events, [ask("maya")]), null);
});

test("an agent you drive waiting on your yes moves the box to it", () => {
  const events = room();
  const approval = ev(kiroBot, { type: "engine.approval", id: "k1", tool: "kiro", scope: "commands", items: ["npm test"] } as EventBody, "kiro");
  assert.equal(look(events, [approval])?.lane, "kiro");
});

test("never while words are in the box, nor right after you chose an agent yourself", () => {
  const events = room();
  assert.equal(look(events, [handoff()], { typing: true }), null, "half a message is meant for where it points");
  assert.equal(look(events, [handoff()], { pickedAt: Date.now() - 1000 }), null, "your own pick holds");
  assert.equal(look(events, [handoff()], { pickedAt: Date.now() - PICKED_HOLD_MS - 1 })?.lane, "kiro", "for a while");
});

test("not to an agent you can't write to, and not for work that moved between two other agents", () => {
  const events = room();
  assert.equal(look(events, [handoff()], { mayWrite: (l) => l !== "kiro" }), null);
  const byMaya = handoff();
  byMaya.actor = { id: "maya", name: "Maya", kind: "human" };
  assert.equal(look(events, [byMaya], { target: MAIN_LANE }), null, "Maya passing Codex's work to Kiro while you write to Friday Code: not yours to follow");
  assert.equal(look(events, [handoff()], { target: MAIN_LANE })?.lane, "kiro", "one you sent yourself is");
});

test("the agent being written to going away moves the box to one working for you, else Main", () => {
  const events = room();
  const removed = ev(ada, { type: "lane.removed", laneId: "codex" } as EventBody);
  assert.equal(look(events, [removed])?.lane, MAIN_LANE);
  const running = ev(kiroBot, { type: "run.started", causedBy: 1 }, "kiro");
  const f = look([...events, running], [removed]);
  assert.equal(f?.lane, "kiro");
  assert.match(f!.why, /Codex isn't here any more/);
});

test("nothing new, nothing moves; the newest reason wins when several arrive at once", () => {
  const events = room();
  assert.equal(look(events, []), null);
  const ask = ev(codexBot, { type: "agent.question", callId: "q2", question: "Which?", to: "ada", toName: "Ada" } as EventBody, MAIN_LANE);
  const f = look(events, [handoff(), ask]);
  assert.equal(f?.lane, MAIN_LANE, "the question came last");
});

test("a coding tool ending its answer with a question for you moves the box to it", () => {
  const events = room();
  events.push(ev(ada, { type: "engine.attached", engine: { tool: "kiro", hostId: "h1", hostName: "Ada", cwd: "/w", mode: "edits" } } as EventBody, "kiro"));
  const asking = ev(kiroBot, { type: "agent.message", text: "Before I plan further:\n\n[1] What's the primary goal right now?\n- a. Accuracy\n- b. Generalisation", toolCalls: [] }, "kiro");
  const f = look(events, [asking]);
  assert.equal(f?.lane, "kiro");
  const plain = ev(kiroBot, { type: "agent.message", text: "Done: the baseline is recorded.", toolCalls: [] }, "kiro");
  assert.equal(look(events, [plain]), null, "a plain answer isn't a question");
});
