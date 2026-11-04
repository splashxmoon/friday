import assert from "node:assert/strict";
import test from "node:test";
import { crewOf } from "../src/attention.js";
import type { SessionState } from "../src/session/projection.js";

// After a restart a finished session's tool isn't attached until it is sent something; it read "Offline" though its computer was
// right there (2026-11-04 end-to-end check). It is offline only when its computer is.
test("a tool not attached is offline only when its computer isn't linked", () => {
  const state = {
    id: "s1",
    lanes: [],
    run: { status: "idle", sinceSeq: 0 },
    laneRuns: {},
    engines: { main: { tool: "claude", hostId: "h1", hostName: "Mac", cwd: "", mode: "full", online: false, sinceSeq: 3 } },
    openQuestions: {},
    approvals: {},
    finished: { main: 9 },
    options: { agent: null },
  } as unknown as SessionState;
  assert.equal(crewOf(state, () => true)!.agents[0]!.state, "done");
  assert.equal(crewOf(state, () => false)!.agents[0]!.state, "offline");
  assert.equal(crewOf(state)!.agents[0]!.state, "offline");
});

// Home's "Right now" read Friday's own nudge to the agent: "Keep going: your plan still has 1 step open…".
test("a session's preview is what a person said, never Friday's nudge to keep going", async () => {
  const { project } = await import("../src/session/projection.js");
  const { previewOf } = await import("../src/attention.js");
  const at = (seq: number, actor: { id: string; name: string; kind: string }, body: Record<string, unknown>) => ({ seq, ts: seq, actor, body }) as never;
  const me = { id: "u1", name: "Maya", kind: "human" };
  const friday = { id: "friday", name: "Friday", kind: "system" };
  const s = project("s1", [
    at(1, me, { type: "session.created", title: "Export", ownerName: "Maya" }),
    at(2, me, { type: "instruction", text: "Build the export screen" }),
    at(3, friday, { type: "instruction", text: "Keep going: your plan still has 1 step open.", keepGoing: true }),
  ]);
  assert.equal(previewOf(s)?.text, "Build the export screen");
});

// "Kit stopped at 4 of 5 · Continue" came back after every later turn, and Needs you asked to carry on a plan from long before.
test("a plan stopped short is for the work it was made for: new work clears it, Friday's keep-going nudge doesn't", async () => {
  const { project } = await import("../src/session/projection.js");
  const at = (seq: number, actor: { id: string; name: string; kind: string }, body: Record<string, unknown>) => ({ seq, ts: seq, actor, body }) as never;
  const me = { id: "u1", name: "Maya", kind: "human" };
  const friday = { id: "friday", name: "Friday", kind: "system" };
  const agent = { id: "a", name: "Claude Code", kind: "agent" };
  const plan = JSON.stringify({ plan: [1, 2, 3, 4, 5].map((n) => ({ step: `Step ${n}`, status: n <= 4 ? "completed" : "pending" })) });
  const log = [
    at(1, me, { type: "session.created", title: "Export", ownerName: "Maya" }),
    at(2, me, { type: "instruction", text: "STORM build the export screen" }),
    at(3, agent, { type: "agent.message", text: "Working.", toolCalls: [{ id: "c1", name: "update_plan", arguments: plan }] }),
  ];
  assert.deepEqual(project("s1", log).planDone?.main, { done: 4, of: 5 });
  assert.deepEqual(project("s1", [...log, at(4, friday, { type: "instruction", text: "Keep going", keepGoing: true })]).planDone?.main, { done: 4, of: 5 });
  assert.equal(project("s1", [...log, at(4, me, { type: "instruction", text: "Now fix the header" })]).planDone?.main, undefined);
});
