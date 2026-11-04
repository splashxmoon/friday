// The sidebar after Orca's (Arun, 2026-11-03: "Start with 1–4"): rows settle rather than jump, a working agent unheard for a
// while is said as quiet and never as done, and the row says what the one at work is doing this minute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crewOf, workingIn } from "../src/attention.js";
import { settleOrder } from "../src/client/sidebar-order.js";
import { callDoing, project } from "../src/session/projection.js";
import { doingWords, QUIET_AFTER_MS, quietFor } from "../src/step-words.js";
import type { ActorRef, EventBody, SessionEvent } from "../src/types.js";

const human: ActorRef = { id: "u1", name: "Arun", kind: "human" };
const agent: ActorRef = { id: "engine:h1", name: "Mac's Claude Code", kind: "agent" };
const system: ActorRef = { id: "friday", name: "Friday", kind: "system" };
const T = 1_800_000_000_000;
let seq = 0;
const ev = (actor: ActorRef, body: EventBody, ts: number): SessionEvent => ({ seq: ++seq, ts, actor, body });
const created = () => ev(human, { type: "session.created", title: "t", ownerId: "u1", ownerName: "Arun" }, T);

test("settling keeps what stays where it was, drops what's gone and slots what's new where the order puts it", () => {
  assert.deepEqual(settleOrder(["a", "b", "c"], ["c", "a", "b"]), ["a", "b", "c"]);
  assert.deepEqual(settleOrder(["a", "b", "c"], ["c", "a"]), ["a", "c"]);
  assert.deepEqual(settleOrder(["a", "b", "c"], ["n", "c", "a", "b"]), ["n", "a", "b", "c"]);
  assert.deepEqual(settleOrder(["a", "b", "c"], ["c", "a", "n", "b"]), ["a", "n", "b", "c"]);
  assert.deepEqual(settleOrder([], ["x", "y"]), ["x", "y"]);
});

test("an agent's own events are when it was last heard from; the system's and people's are not", () => {
  seq = 0;
  const s = project("s1", [
    created(),
    ev(human, { type: "run.started", causedBy: 0 }, T + 1000),
    ev(agent, { type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "edit", arguments: JSON.stringify({ path: "src/client/Sidebar.tsx" }) }] }, T + 5000),
    ev(system, { type: "session.updated", options: {} }, T + 900_000),
    ev(human, { type: "session.updated", options: {} }, T + 950_000),
  ]);
  assert.equal(s.heardAt?.main, T + 5000);
  const w = workingIn(s)!;
  assert.equal(w.heardAt, T + 5000);
  const a = crewOf(s)!.agents[0]!;
  assert.equal(a.state, "working");
  assert.deepEqual(a.doing, { name: "edit", target: "src/client/Sidebar.tsx" });
  assert.equal(doingWords(a.doing!), "Editing Sidebar.tsx");
  // Ten minutes and more unheard is quiet, said rounded down.
  assert.ok(T + 950_000 - a.heardAt! > QUIET_AFTER_MS);
  assert.equal(quietFor(a.heardAt!, T + 5000 + 14.9 * 60_000), "14m");
});

test("a run that ended is doing nothing, and one that stopped on an error says why in its first line", () => {
  seq = 0;
  const s = project("s2", [
    created(),
    ev(human, { type: "run.started", causedBy: 0 }, T + 1000),
    ev(agent, { type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "shell", arguments: JSON.stringify({ command: "npm test\nmore" }) }] }, T + 2000),
    ev(agent, { type: "run.ended", outcome: "error", error: "The folder disconnected.\nat x (y.js:1:2)" }, T + 3000),
  ]);
  assert.equal(s.doing?.main, undefined);
  const a = crewOf(s)!.agents[0]!;
  assert.equal(a.state, "failed");
  assert.equal(a.why, "The folder disconnected.");
  assert.equal(a.doing, undefined);
});

test("a step is said by its tool's common name, never raw arguments", () => {
  assert.deepEqual(callDoing({ name: "shell", arguments: JSON.stringify({ command: "npm run build\n&& more" }) }), { name: "shell", target: "npm run build" });
  assert.deepEqual(callDoing({ name: "read", arguments: "{not json" }), { name: "read" });
  assert.equal(doingWords({ name: "shell", target: "npm run build" }), "Running npm run build");
  assert.equal(doingWords({ name: "web_fetch", target: "https://www.example.com/a" }), "Reading example.com");
  assert.equal(doingWords({ name: "mcp__github__create_pr" }), "Using github");
  assert.equal(doingWords({ name: "something_new" }), "Working");
});
