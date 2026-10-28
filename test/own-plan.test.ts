import assert from "node:assert/strict";
import { test } from "node:test";
import { ownPlan, refusal, taskOwner, whoseWork } from "../src/own-plan.js";
import { canDriveLane, project, type LaneEngine } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/**
 * Arun, 2026-10-27: "i do not want my account banned or whatever for other people too". A coding tool on its host's own plan
 * (Claude Free/Pro/Max, a ChatGPT plan, the others') does its host's work alone; one on an API key its host shares may take
 * anyone's in the session.
 */

const ada: ActorRef = { id: "u-ada", name: "Ada", kind: "human" };
const bo: ActorRef = { id: "u-bo", name: "Bo", kind: "human" };
const friday: ActorRef = { id: "friday", name: "Friday", kind: "system" };
const agent: ActorRef = { id: "agent", name: "Codex", kind: "agent" };

const engine = (over: Partial<LaneEngine> = {}): LaneEngine => ({ tool: "claude", hostId: ada.id, hostName: "Ada", cwd: "/w", online: true, sinceSeq: 0, mode: "full", ...over }) as LaneEngine;
const log = (rows: [ActorRef, EventBody, string?][]): SessionEvent[] => rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: 1, actor, body, ...(lane ? { lane } : {}) }) as SessionEvent);
const say = (text: string, more: Record<string, unknown> = {}): EventBody => ({ type: "instruction", text, interrupt: false, ...more }) as EventBody;

test("a tool on its host's own plan takes its host's work alone; on an API key, anyone's in the session", () => {
  assert.ok(ownPlan(engine()));
  assert.ok(ownPlan(engine({ tool: "codex" })), "a ChatGPT plan too");
  assert.ok(!ownPlan(engine({ apiKey: true })), "a key its host shares");
  assert.ok(!ownPlan(engine({ tool: undefined })), "Friday Code spends the workspace's credit, not a person's plan");
  assert.equal(refusal(engine(), ada.id), null, "its host's own work");
  assert.equal(refusal(engine(), null), null, "nobody's in particular (Friday carrying on its own task)");
  assert.match(refusal(engine(), bo.id, "Bo") ?? "", /Claude Code here runs on Ada's own Claude plan, so it takes Ada's work only, not Bo's\. Bo can send Ada a suggestion, or connect their own Claude Code\./);
  assert.equal(refusal(engine({ apiKey: true }), bo.id, "Bo"), null);
});

test("whose work a turn is, followed through agents, hand-offs and Friday's own nudges", () => {
  const events = log([
    [ada, say("Fix the cart total."), "lc"],
    [friday, say("Keep going", { keepGoing: true }), "lc"],
    [bo, say("Write the release notes."), "lx"],
    // Bo's Codex asks Ada's Claude Code something: it is Bo's work.
    [agent, say("What did you change?", { mesh: { id: "m1", kind: "ask", fromLane: "lx", fromName: "Codex", toName: "Claude Code", hop: 1, by: { id: bo.id, name: "Bo" } } }), "lc"],
    // A hand-off from Bo's lane: Bo's work too.
    [agent, say("Carry on.", { handoff: { fromLane: "lx", fromName: "Codex", toName: "Claude Code", reason: "out of usage", carried: [] } }), "lc"],
    // An agent message that names nobody: the work of whoever its lane was doing it for.
    [agent, say("FYI", { mesh: { id: "m2", kind: "tell", fromLane: "lx", fromName: "Codex", toName: "Claude Code", hop: 1, by: null } }), "lc"],
  ]);
  assert.equal(whoseWork(events, events[0]!), ada.id);
  assert.equal(whoseWork(events, events[1]!), ada.id, "Friday's keep-going is Ada's task going on");
  assert.equal(whoseWork(events, events[3]!), bo.id);
  assert.equal(whoseWork(events, events[4]!), bo.id);
  assert.equal(whoseWork(events, events[5]!), bo.id);
  assert.equal(taskOwner(events, "lc", 3), ada.id);
  assert.equal(taskOwner(events, MAIN_LANE, 99), null, "a lane nobody gave work");
});

test("only its host steers a tool on their own plan, whatever the session's policy or who owns it", () => {
  const events = log([
    [ada, { type: "session.created", title: "t", ownerId: bo.id, ownerName: "Bo" } as EventBody],
    [bo, { type: "member.joined", userId: ada.id, name: "Ada", role: "editor" } as EventBody],
  ]);
  const s = project("s", events);
  s.engines[MAIN_LANE] = engine();
  assert.ok(!canDriveLane(s, bo.id, MAIN_LANE), "not even the session's owner");
  s.engines[MAIN_LANE] = engine({ apiKey: true });
  assert.ok(canDriveLane(s, bo.id, MAIN_LANE), "on a key Ada shares, the session's own rules decide");
});
