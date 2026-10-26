import assert from "node:assert/strict";
import test from "node:test";
import { hubOf } from "../src/agents-hub.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/** The Agents hub: each agent's state and line, its plan, the changes across agents, and the checks. */
let seq = 0;
const human = { id: "ada", name: "Ada", kind: "human" as const };
const tool = { id: "engine:claude", name: "Ada's Claude Code", kind: "agent" as const };
const ev = (body: EventBody, actor: SessionEvent["actor"] = tool, lane?: string): SessionEvent => ({ seq: ++seq, ts: 1000 * seq, actor, body, ...(lane ? { lane } : {}) });

function session(): SessionEvent[] {
  seq = 0;
  return [
    ev({ type: "session.created", title: "t", ownerId: "ada", ownerName: "Ada", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody, human),
    ev({ type: "engine.attached", engine: { tool: "claude", hostId: "ada", hostName: "Ada Lovelace", cwd: "/w", mode: "edits" } } as EventBody),
    ev({ type: "instruction", text: "Fix the streak", interrupt: false }, human),
    ev({ type: "run.started", causedBy: 3 } as EventBody),
    ev({ type: "agent.message", text: "", toolCalls: [{ id: "p", name: "update_plan", arguments: JSON.stringify({ steps: [{ title: "Read", status: "completed" }, { title: "Fix", status: "in_progress" }] }) }] }),
    ev({ type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) }] }),
    ev({ type: "tool.result", callId: "c1", name: "run_command", output: "$ npm test\n9 passing", isError: false } as EventBody),
    ev({ type: "agent.diff", base: "x", files: [{ path: "src/streak.js", status: "modified", additions: 11, deletions: 3, patch: "+a" }, { path: "test/streak.test.js", status: "added", additions: 19, deletions: 1, patch: "+b" }] } as EventBody),
  ];
}

test("a working agent: what it is doing, its plan, the time since it started; the changes and the tests", () => {
  const events = session();
  const hub = hubOf(project("s", events), events, "ada");
  const [a] = hub.agents;
  assert.equal(a!.status, "working");
  assert.equal(a!.name, "Claude Code", "your own tool, by its name");
  assert.equal(hubOf(project("s", events), events, "bea").agents[0]!.name, "Ada's Claude Code", "somebody else's, with their first name");
  assert.equal(a!.line, "Thinking about what to do next");
  assert.deepEqual(a!.plan, { done: 1, total: 2 });
  assert.equal(a!.startedAt, 4000);
  assert.deepEqual(hub.files.map((f) => [f.path, f.adds, f.dels]), [["src/streak.js", 11, 3], ["test/streak.test.js", 19, 1]]);
  assert.deepEqual(hub.checks.map((c) => [c.kind, c.ok, c.summary]), [["tests", true, "9 passed"]]);
  assert.equal(hub.checks[0]!.lane, "main", "who ran it, for Re-run and Ask to fix");
  assert.match(hub.checks[0]!.output, /9 passing/);
  assert.deepEqual(hub.recent.map((s) => [s.text, s.failed]), [["Ran npm test", false]], "recent steps, newest first, the plan left out");
  assert.equal(a!.mode, "edits");
  assert.equal(a!.ask, null);
  const cleaned = [...events, ev({ type: "agent.message", text: "", toolCalls: [{ id: "c2", name: "run_command", arguments: JSON.stringify({ command: "rm -rf build" }) }] }), ev({ type: "tool.result", callId: "c2", name: "run_command", output: "$ rm -rf build", isError: false } as EventBody)];
  assert.deepEqual(hubOf(project("s", cleaned), cleaned).checks.map((c) => c.kind), ["tests"], "deleting a build folder is not a build");
});

test("waiting on a permission answer, then done with its answer as the line, then offline", () => {
  const asking = [...session(), ev({ type: "engine.approval", id: "k", tool: "claude", scope: "commands", items: ["rm -rf build"], live: true } as EventBody)];
  const w = hubOf(project("s", asking), asking).agents[0]!;
  assert.equal(w.status, "waiting");
  assert.equal(w.line, "Needs you: rm -rf build");
  assert.deepEqual(w.ask, { id: "k", items: ["rm -rf build"], scope: "commands" }, "what Run it / Don't answer");

  const done = [...session(), ev({ type: "agent.message", text: "Fixed the streak off-by-one.\n\nDetails…", toolCalls: [] }), ev({ type: "run.ended", outcome: "done" })];
  const d = hubOf(project("s", done), done).agents[0]!;
  assert.equal(d.status, "done");
  assert.equal(d.line, "Fixed the streak off-by-one.");
  assert.equal(d.endedAt! - d.startedAt!, 6000, "how long it took");

  const gone = [...done, ev({ type: "engine.detached", reason: "disconnected" } as EventBody)];
  const o = hubOf(project("s", gone), gone).agents[0]!;
  assert.equal(o.status, "offline");
  assert.equal(o.line, "Offline · Ada's computer", "somebody else's computer, named");
  assert.equal(hubOf(project("s", gone), gone, "ada").agents[0]!.line, "Offline · reconnect it from the chat", "your own, with what to do");
});

test("a question is waiting too, on you only when it was put to you, and a coding tool's closing question needs whoever steers it", () => {
  const asked = [...session(), ev({ type: "agent.question", callId: "q", question: "Keep the old API?\nIt has two callers.", to: "ada", toName: "Ada Lovelace" } as EventBody)];
  const mine = hubOf(project("s", asked), asked, "ada").agents[0]!;
  assert.equal(mine.status, "waiting", "not working: it is waiting on an answer");
  assert.equal(mine.line, "Asking you: Keep the old API?");
  assert.equal(mine.needsYou, true);
  const theirs = hubOf(project("s", asked), asked, "bea").agents[0]!;
  assert.equal(theirs.line, "Asking Ada: Keep the old API?");
  assert.equal(theirs.needsYou, false, "somebody else's question isn't on you");

  const decision = [...session(), ev({ type: "agent.message", text: "Which way?\n\n[1] Storage\na. Postgres\nb. SQLite", toolCalls: [] }), ev({ type: "run.ended", outcome: "done" })];
  const d = hubOf(project("s", decision), decision, "ada").agents[0]!;
  assert.equal(d.status, "waiting");
  assert.match(d.line, /^Needs a decision: /);
  assert.equal(hubOf(project("s", session()), session(), "ada").agents[0]!.needsYou, false, "a working agent needs nobody");
});

test("a renamed coding tool is called by its new name, in the hub and wherever it is named", async () => {
  const events = [...session(), ev({ type: "lane.renamed", laneId: "main", name: "Backend lead" } as EventBody, human)];
  const state = project("s", events);
  assert.equal(hubOf(state, events, "ada").agents[0]!.name, "Backend lead");
  assert.equal(hubOf(state, events, "bea").agents[0]!.name, "Ada's Backend lead");
  const { givenName } = await import("../src/session/projection.js");
  const { laneLabel } = await import("../src/left-off.js");
  assert.equal(givenName(state, "main"), "Backend lead");
  assert.equal(laneLabel(state, "main"), "Backend lead");
  // Named after its own tool is no name of its own.
  const plain = [...session(), ev({ type: "lane.renamed", laneId: "main", name: "claude code" } as EventBody, human)];
  assert.equal(givenName(project("s", plain), "main"), null);
});

test("an agent out of usage says until when, as its own state, and is ready again once its limit lifts", (t) => {
  const events = [...session(), ev({ type: "run.ended", outcome: "error", error: "Claude AI usage limit reached. Try again in 2 hours." } as EventBody)];
  const ended = events.at(-1)!.ts;
  t.mock.timers.enable({ apis: ["Date"], now: ended + 60_000 });
  const [a] = hubOf(project("s", events), events, "ada").agents;
  assert.equal(a!.status, "limited");
  assert.match(a!.line, /^Out of usage until \d{1,2}:\d{2}/);
  t.mock.timers.setTime(ended + 3 * 3_600_000);
  const [b] = hubOf(project("s", events), events, "ada").agents;
  assert.deepEqual([b!.status, b!.line], ["ready", "Usage back · ready for a task"], "not out for good");
});

test("each agent says how many tokens it has used here, cache reads left out", () => {
  const events = [...session(), ev({ type: "agent.usage", input: 12_000, output: 3_000, cached: 900_000 } as EventBody), ev({ type: "agent.usage", input: 1_000, output: 500 } as EventBody)];
  assert.equal(hubOf(project("s", events), events, "ada").agents[0]!.tokens, 16_500);
});
