import assert from "node:assert/strict";
import test from "node:test";
import { bouncesBetween, carriedFor, describeLane, MAX_BOUNCES, resolveTarget } from "../src/handoff.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const human = (name: string) => ({ id: name, name, kind: "human" as const });
const agent = (name: string) => ({ id: `agent:${name}`, name, kind: "agent" as const });

let seq = 0;
const ev = (actor: SessionEvent["actor"], body: EventBody, lane?: string): SessionEvent => ({ seq: ++seq, ts: Date.now(), actor, body, ...(lane ? { lane } : {}) });

const snap = (id: string, name: string, instructions: string) => ({ id, name, icon: "agent", color: "indigo", instructions, tools: { webSearch: false, askHuman: false, connections: "none" as const }, version: 1, ownerName: "Ada" });
const laneOf = (id: string, name: string, instructions: string) => ({ id, name, agent: snap(`a-${id}`, name, instructions), control: { kind: "open" as const }, controlMode: "ask" as const, trigger: { kind: "manual" as const } });

/** A session with Friday Code, Maya's Claude Code, a Reviewer and a Test Writer. */
function room(extra: SessionEvent[] = []) {
  seq = 0;
  const events = [
    ev(human("Ada"), { type: "session.created", title: "Invites", ownerId: "Ada", ownerName: "Ada", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody),
    ev(human("Ada"), { type: "lane.added", lane: { id: "lane-maya", name: "Maya's Claude Code", agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } }),
    ev(human("Maya"), { type: "engine.attached", engine: { tool: "claude", hostId: "h1", hostName: "Maya", cwd: "/w", mode: "full" } }, "lane-maya"),
    ev(human("Ada"), { type: "lane.added", lane: laneOf("lane-review", "Reviewer", "Read a diff and say what changes behaviour. Security, review and correctness.") }),
    ev(human("Ada"), { type: "lane.added", lane: laneOf("lane-tests", "Test Writer", "Write the failing test first. Tests for edge cases and regressions.") }),
    ...extra,
  ];
  return { events, state: project("s", events) };
}

test("the name as the session shows it is taken as it is", () => {
  const { state } = room();
  assert.deepEqual(resolveTarget(state, "main", "Reviewer"), { ok: true, to: "lane-review", how: "named" });
  assert.deepEqual(resolveTarget(state, "main", "lane-tests"), { ok: true, to: "lane-tests", how: "named" });
});

test("it is understood the way a person would say it", () => {
  const { state } = room();
  assert.deepEqual(resolveTarget(state, "main", "claude"), { ok: true, to: "lane-maya", how: "matched" }, "the tool behind a lane names it");
  assert.deepEqual(resolveTarget(state, "main", "test"), { ok: true, to: "lane-tests", how: "matched" }, "a piece of a name does");
  const two = resolveTarget(state, "main", "e"); // too short to mean anything
  assert.equal(two.ok, false);
});

test("an ambiguous name asks, rather than guessing", () => {
  const { state } = room([ev(human("Ada"), { type: "lane.added", lane: laneOf("lane-review2", "Review Bot", "Reviews pull requests.") })]);
  const r = resolveTarget(state, "main", "review");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Reviewer.*Review Bot|Review Bot.*Reviewer/);
});

test("with no name, the best fit for the work is picked when it is clear", () => {
  const { state } = room();
  const r = resolveTarget(state, "main", "", "Write a failing test for the regression and cover the edge cases");
  assert.deepEqual(r, { ok: true, to: "lane-tests", how: "suggested" });
  const vague = resolveTarget(state, "main", "", "Please look at this");
  assert.equal(vague.ok, false, "nothing stands out, so it says what the choices are");
  if (!vague.ok) assert.match(vague.error, /Reviewer.*Test Writer|Test Writer.*Reviewer/);
});

test("a refusal says what each choice is for", () => {
  const { state } = room();
  const r = resolveTarget(state, "main", "nobody");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /no agent called "nobody"/);
    assert.match(r.error, /Maya's Claude Code" \(Claude Code on Maya's machine\)/);
    assert.match(r.error, /Reviewer" \(Read a diff/);
  }
  assert.match(describeLane(state, "lane-maya"), /Claude Code/);
});

test("what the log knows goes along even when the agent leaves it out", () => {
  const { state } = room([
    ev(agent("Friday Code"), { type: "agent.diff", base: "a", files: [{ path: "src/a.ts", status: "modified", additions: 4, deletions: 1, patch: "" }, { path: "src/b.ts", status: "added", additions: 9, deletions: 0, patch: "" }] }),
  ]);
  const carried = carriedFor(state, "main", ["The merge is right"]);
  assert.equal(carried[0], "The merge is right", "the agent's own lines come first");
  assert.match(carried[1]!, /Changed src\/a\.ts \(\+4 −1\), src\/b\.ts \(\+9 −0\)/);
  const told = carriedFor(state, "main", ["Edited src/a.ts and src/b.ts"]);
  assert.equal(told.length, 1, "files it already named are not listed again");
});

test("an open question goes along too, and the total stays short", () => {
  const { state } = room([ev(agent("Friday Code"), { type: "agent.question", callId: "q", question: "Merge or replace?", to: "Ada", toName: "Ada" })]);
  const carried = carriedFor(state, "main", Array.from({ length: 12 }, (_, i) => `line ${i}`));
  assert.equal(carried.length, 8);
  const few = carriedFor(state, "main", ["one"]);
  assert.match(few.at(-1)!, /A question is open with Ada: Merge or replace\?/);
});

test("work passed back and forth between two agents is counted, and stops at a limit", () => {
  const hop = (from: string, to: string) => ev(agent(from), { type: "instruction", text: "go", interrupt: false, handoff: { fromLane: from, fromName: from, toName: to, reason: "r", carried: [] } }, to);
  const events = [hop("main", "lane-review"), hop("lane-review", "main"), hop("main", "lane-review"), hop("lane-review", "main"), hop("main", "lane-tests")];
  assert.equal(bouncesBetween(events, "main", "lane-review", 0), 4, "both directions count");
  assert.equal(bouncesBetween(events, "main", "lane-tests", 0), 1);
  assert.equal(bouncesBetween(events, "main", "lane-review", Date.now() + 1000), 0, "only the recent ones");
  assert.ok(MAX_BOUNCES >= 3, "a round trip or two is normal; that is not a loop");
});

test("a hand-off's card shows the task, not the brief Friday wrapped it in (Arun, 2026-10-28: \"iron everything\")", async () => {
  const { handoffTaskText } = await import("../src/client/handoff-ui.js");
  const brief = "Carry on with this task, which Claude Code was partway through when it ran out of usage. Don't start over: what it already did is in the record with this, so build on it, then finish the task.\n\nThe task:\nArun: Please write a two-line intro";
  assert.equal(handoffTaskText(brief), "Arun: Please write a two-line intro");
  assert.equal(handoffTaskText("Review the diff for the login change"), "Review the diff for the login change", "a person's own words stay");
});
