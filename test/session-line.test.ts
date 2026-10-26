import assert from "node:assert/strict";
import test from "node:test";
import { goalOf, jumpPlaces, jumpTargets, stateLine, waitingOnMe } from "../src/session-line.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/**
 * The session in one line, the goal pinned, and the places worth jumping to.
 */

const t0 = 1_700_000_000_000;
function log(...rows: [EventBody, number, ("human" | "agent")?][]): SessionEvent[] {
  let seq = 0;
  const created = { type: "session.created", title: "Dark mode", ownerId: "Priya", ownerName: "Priya", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody;
  return [[created, 0] as [EventBody, number], ...rows].map(([body, dt, kind = "human"]) => ({ seq: ++seq, ts: t0 + dt, actor: kind === "human" ? { id: "Priya", name: "Priya", kind } : { id: "engine:x", name: "Friday Code", kind }, body }));
}

test("the line says who is doing what, then how much waits on you", () => {
  const working = log(
    [{ type: "instruction", text: "Add the toggle.", interrupt: false }, 1000],
    [{ type: "run.started", causedBy: 2 }, 2000, "agent"],
    [{ type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "edit_file", arguments: JSON.stringify({ path: "src/auth.ts", find: "a", content: "b" }) }] }, 3000, "agent"],
  );
  assert.equal(stateLine(project("s", working), working, "Priya", t0 + 9000), "Friday Code is editing src/auth.ts");

  const asked = log(
    [{ type: "instruction", text: "Add the toggle.", interrupt: false }, 1000],
    [{ type: "run.started", causedBy: 2 }, 2000, "agent"],
    [{ type: "agent.question", callId: "q", question: "Which colour?", to: "Priya", toName: "Priya" }, 3000, "agent"],
  );
  const st = project("s", asked);
  assert.equal(waitingOnMe(st, "Priya"), 1);
  assert.equal(waitingOnMe(st, "Noah"), 0);
  assert.equal(stateLine(st, asked, "Priya"), "Waiting on Priya · 1 waiting on you");
  assert.equal(stateLine(st, asked, "Noah"), "Waiting on Priya");

  // A second agent asking Noah meanwhile is a second wait, not a replacement for Priya's.
  const both: SessionEvent[] = [...asked, { seq: 5, ts: t0 + 4000, actor: { id: "engine:y", name: "Reviewer", kind: "agent" }, lane: "l1", body: { type: "agent.question", callId: "r", question: "Ship it?", to: "Noah", toName: "Noah" } }];
  const st2 = project("s", both);
  assert.equal(waitingOnMe(st2, "Priya"), 1);
  assert.equal(waitingOnMe(st2, "Noah"), 1);
  assert.equal(stateLine(st2, both, "Noah"), "Waiting on Priya and Noah · 1 waiting on you");

  const idle = log([{ type: "instruction", text: "Go.", interrupt: false }, 1000], [{ type: "run.started", causedBy: 2 }, 2000, "agent"], [{ type: "run.ended", outcome: "done" }, 3000, "agent"]);
  assert.equal(stateLine(project("s", idle), idle, "Priya", t0 + 3000 + 2 * 3600_000), "Idle · last ran 2h ago");
  assert.equal(stateLine(project("s", log()), log(), "Priya"), "Nothing has run yet");
});

test("the goal is the first ask with the plan's progress, and the jump targets are the newest of each kind", () => {
  const events = log(
    [{ type: "instruction", text: "Add a dark mode toggle to the settings page, with a test.", interrupt: false }, 1000],
    [{ type: "run.started", causedBy: 2 }, 2000, "agent"],
    [{ type: "agent.message", text: "", toolCalls: [{ id: "p", name: "update_plan", arguments: JSON.stringify({ steps: [{ title: "Read", status: "completed" }, { title: "Edit", status: "in_progress" }, { title: "Test", status: "pending" }] }) }] }, 2500, "agent"],
    [{ type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) }] }, 3000, "agent"],
    [{ type: "tool.result", callId: "c1", name: "run_command", output: "$ npm test\n(exited 1)\n1 failing", isError: true } as EventBody, 4000, "agent"],
    [{ type: "agent.diff", base: "x", files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "" }] } as EventBody, 5000, "agent"],
    [{ type: "run.ended", outcome: "done" }, 6000, "agent"],
    [{ type: "instruction", text: "Looks good.", interrupt: false }, 7000],
  );
  const goal = goalOf(project("s", events), events)!;
  assert.equal(goal.seq, 2);
  assert.equal(goal.text, "Add a dark mode toggle to the settings page, with a test.");
  assert.deepEqual(goal.steps, { done: 1, total: 3 });
  assert.deepEqual(jumpTargets(events, "Priya"), { diff: 7, failure: 6, mine: 9, review: 8 });
  assert.equal(goalOf(project("s", log()), log()), null);
});

test("the Jump menu says what waits at each place: the command that failed, the files, how the run ended, your words", () => {
  const events = log(
    [{ type: "instruction", text: "Add a dark mode toggle to the settings page, with a test.", interrupt: false }, 1000],
    [{ type: "run.started", causedBy: 2 }, 2000, "agent"],
    [{ type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) }] }, 3000, "agent"],
    [{ type: "tool.result", callId: "c1", name: "run_command", output: "$ npm test\n(exited 1)\n1 failing", isError: true } as EventBody, 4000, "agent"],
    [{ type: "agent.diff", base: "x", files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "" }, { path: "src/b.ts", status: "added", additions: 9, deletions: 0, patch: "" }] } as EventBody, 5000, "agent"],
    [{ type: "run.ended", outcome: "done" }, 6000, "agent"],
    [{ type: "instruction", text: "[session] Carry on where you left off.", interrupt: false }, 6500],
    [{ type: "instruction", text: "Looks good.", interrupt: false }, 7000],
  );
  assert.deepEqual(
    jumpPlaces(events, "Priya").map((p) => [p.key, p.label, p.detail, p.seq]),
    [
      ["f", "Last failure", "npm test", 5],
      ["d", "Last diff", "2 files · +12 −1", 6],
      ["r", "Last finished run", "Done", 7],
      ["m", "My last message", "“Looks good.”", 9],
    ],
    "in the order they matter; no question was asked, and Friday's own carry-on isn't yours",
  );
  assert.deepEqual(jumpPlaces(log(), "Priya"), []);
});
