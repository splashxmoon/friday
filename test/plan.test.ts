import assert from "node:assert/strict";
import { test } from "node:test";
import { planSteps } from "../src/client/Activity.js";
import { progressLabel, type ProgressStep } from "../src/client/components/agents/agent-progress.js";
import { updatePlan } from "../src/agent/tools.js";
import type { ToolContext } from "../src/agent/tools.js";

/**
 * The plan block: what's done, what's happening, what's left.
 *
 * Two agents write plans in two shapes — a CLI's `todo` with `todos`, Friday's
 * `update_plan` with `steps` — and the room reads one block either way.
 */

test("both agents' plans parse into the same steps", () => {
  const cli = planSteps({ todos: [{ content: "Read project files", status: "completed" }, { content: "Update tokens", status: "in_progress" }, { content: "Run the build", status: "pending" }] }, true);
  const friday = planSteps({ steps: [{ title: "Read project files", status: "completed" }, { title: "Update tokens", status: "in_progress" }, { title: "Run the build", status: "pending" }] }, true);
  assert.deepEqual(cli.map((s) => s.status), ["completed", "active", "pending"]);
  assert.deepEqual(
    cli.map((s) => s.title),
    friday.map((s) => s.title),
  );
  assert.deepEqual(cli.map((s) => s.status), friday.map((s) => s.status));
});

test("a finished run has nothing in progress", () => {
  const done = planSteps({ steps: [{ title: "a", status: "completed" }, { title: "b", status: "in_progress" }] }, false);
  assert.deepEqual(done.map((s) => s.status), ["completed", "pending"], "a stopped run must not leave a step spinning");
  assert.equal(planSteps({ steps: [{ title: "", status: "pending" }] }, true).length, 0, "a step with no title is not a step");
});

test("the header counts what is left, and says so when there is nothing", () => {
  const steps = (n: number, done: number): ProgressStep[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${i}`, title: `s${i}`, status: i < done ? "completed" : "pending" }));
  assert.equal(progressLabel(steps(5, 2)), "3 steps left");
  assert.equal(progressLabel(steps(2, 1)), "1 step left");
  assert.equal(progressLabel(steps(3, 3)), "Done · 3 steps");
  assert.equal(progressLabel([]), "No steps yet");
});

test("update_plan takes the whole plan and answers with the count, not the list", async () => {
  const ctx = {} as ToolContext;
  const ok = await updatePlan.run({ steps: [{ title: "Read the files", status: "completed" }, { title: "Write the fix", status: "in_progress" }, { title: "Run the tests", status: "pending" }] }, ctx, "c1");
  assert.match(ok.output, /2 of 3 steps still to do/);
  assert.ok(!ok.output.includes("Read the files"), "the model just sent the list; reading it back costs tokens and says nothing");

  const finished = await updatePlan.run({ steps: [{ title: "Done", status: "completed" }] }, ctx, "c2");
  assert.match(finished.output, /All 1 steps done/);

  const empty = await updatePlan.run({ steps: [] }, ctx, "c3");
  assert.equal(empty.isError, true);
});

/**
 * Finishing what it started.
 *
 * A model that stops mid-plan usually stops for no reason it could defend: it
 * wrote the steps itself and three of them are still pending. The run reads
 * its own plan back from the log and carries on rather than leaving somebody
 * to type "continue" at an agent that already knows what's next.
 */
test("an unfinished plan is counted from the newest plan on that lane, in this run", async () => {
  const { unfinishedPlan } = await import("../src/agent/runtime.js");
  const ev = (seq: number, lane: string, steps: { title: string; status: string }[]) => ({
    seq,
    ts: seq,
    lane,
    actor: { id: "agent", name: "Agent", kind: "agent" as const },
    body: { type: "agent.message" as const, text: "", toolCalls: [{ id: `c${seq}`, name: "update_plan", arguments: JSON.stringify({ steps }) }] },
  });
  const events = [
    ev(1, "main", [{ title: "a", status: "pending" }, { title: "b", status: "pending" }]),
    ev(2, "main", [{ title: "a", status: "completed" }, { title: "b", status: "in_progress" }]),
  ];
  assert.equal(unfinishedPlan(events, "main", 0), 1, "the newest plan wins, not the first one");
  assert.equal(unfinishedPlan(events, "other", 0), 0, "another lane's plan is somebody else's work");
  assert.equal(unfinishedPlan(events, "main", 2), 0, "a plan from before this run is history");

  const done = [...events, ev(3, "main", [{ title: "a", status: "completed" }, { title: "b", status: "cancelled" }])];
  assert.equal(unfinishedPlan(done, "main", 0), 0, "cancelled counts as settled — it just isn't going to happen");
  assert.equal(unfinishedPlan([], "main", 0), 0);
});
