import assert from "node:assert/strict";
import test from "node:test";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/**
 * A coding tool asking permission mid-turn waits for the answer there and then. A message written meanwhile used to clear the
 * ask: its card went, the tool kept waiting for an answer nobody could give any more, and the lane never moved again.
 */
let seq = 0;
const person = { id: "Ada", name: "Ada", kind: "human" as const };
const ev = (body: EventBody, lane?: string): SessionEvent => ({ seq: ++seq, ts: seq, actor: person, body, ...(lane ? { lane } : {}) });
const start = () => {
  seq = 0;
  return [ev({ type: "session.created", title: "t", ownerId: "Ada", ownerName: "Ada", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody)];
};
const ask = (live: boolean, lane?: string) => ev({ type: "engine.approval", id: "k1", tool: "claude", scope: "commands", items: ["npm test"], ...(live ? { live: true } : {}) }, lane);

test("a live ask stays through a message written meanwhile, and goes when it is answered or the turn is interrupted", () => {
  const log = [...start(), ask(true), ev({ type: "instruction", text: "also update the README", interrupt: false })];
  assert.equal(project("s", log).approvals.main?.id, "k1", "still asked: its card stays, and the message waits for the turn");
  assert.equal(project("s", [...log, ev({ type: "instruction", text: "Yes, run it.", interrupt: false, approval: { id: "k1", approve: true } })]).approvals.main, undefined, "answered");
  assert.equal(project("s", [...log, ev({ type: "instruction", text: "stop, do this instead", interrupt: true })]).approvals.main, undefined, "interrupted: the turn it was asked in is over");
});

test("an ask from a turn that has ended is passed over by the next message, as before", () => {
  const log = [...start(), ask(false), ev({ type: "instruction", text: "never mind, do something else", interrupt: false })];
  assert.equal(project("s", log).approvals.main, undefined);
});

test("taking an agent out of the session takes its question with it", () => {
  const lane = { id: "l2", name: "Second", agent: null, control: { kind: "open" as const }, controlMode: "ask" as const, trigger: { kind: "manual" as const } };
  const log = [...start(), ev({ type: "lane.added", lane }), ask(true, "l2"), ev({ type: "lane.removed", laneId: "l2" })];
  assert.equal(project("s", log).approvals.l2, undefined);
});

test("a live ask goes when its run is stopped or cancelled or its tool disconnects", () => {
  const log = [...start(), ask(true)];
  assert.equal(project("s", [...log, ev({ type: "run.pause" })]).approvals.main, undefined, "stopped: the turn it was asked in is over, and the agent is free");
  assert.equal(project("s", [...log, ev({ type: "run.cancel" })]).approvals.main, undefined, "cancelled: the turn it was asked in is over");
  assert.equal(project("s", [...log, ev({ type: "engine.detached", reason: "disconnected" })]).approvals.main, undefined, "disconnected: nothing is waiting for the answer");
  assert.equal(project("s", [...start(), ask(true, "l2"), ev({ type: "run.cancel" })]).approvals.l2?.id, "k1", "another agent's cancel leaves it");
});

test("a commit to a new branch moves the folder onto it, so the next commit doesn't offer yet another branch", () => {
  const log = [
    ...start(),
    ev({ type: "engine.attached", engine: { tool: "claude", hostId: "h", hostName: "Ada", cwd: "/w", mode: "edits", branch: "main" } }),
    ev({ type: "folder.committed", sha: "a".repeat(40), branch: "friday/fix-cart", message: "Fix cart", files: 1 }),
  ];
  assert.equal(project("s", log).engines.main?.branch, "friday/fix-cart");
});

test("Claude Code's own limit wording gets the explanation of what to do next", async () => {
  const { claude } = await import("../src/runner/adapters.js");
  for (const said of ["5-hour limit reached ∙ resets 3pm (America/New_York)", "Weekly limit reached ∙ resets Oct 14, 3pm", "Claude usage limit reached. Your limit will reset at 4pm."]) {
    const e = claude.explain(said);
    assert.match(e, /carry on when the limit resets, or hand the work to another agent/, said);
    assert.doesNotMatch(e, /Friday Code/, "nothing a Solo person can't do");
  }
});
