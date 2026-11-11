import assert from "node:assert/strict";
import test from "node:test";
import { taskAsk } from "../src/client/TeamPlan.js";

// A plan card's ask is the task, not Friday's instructions to the teammate (Arun, 2026-11-11: "sometimes its too long").
test("a workflow step's card says the step, with its workflow as a fact, and none of Friday's instructions", () => {
  const detail = [
    '[Workflow "Weekday Bug Sweep", step 1 of 5] Run the tests and list every bug you find, with how to reproduce each one.',
    "What started this run:\nIt's 2026-11-03 14:00 UTC.",
    "End with a short report of what you made or found: it is handed to the next step.",
    "Do this step yourself; don't post a new board (it would replace this workflow's).",
  ].join("\n\n");
  assert.deepEqual(taskAsk(detail), { ask: "Run the tests and list every bug you find, with how to reproduce each one.", workflow: "Weekday Bug Sweep, step 1 of 5" });
  const check = taskAsk('[Workflow "Ship", step 4 of 5: a check] Check whether this holds: the security review finds nothing.\n\nLook at what the steps before handed on and at the work itself: run the tests, open the files. Don\'t change anything yourself.\n\nEnd your report with one line on its own: PASS if it holds, or FAIL: what isn\'t right, in one sentence.');
  assert.deepEqual(check, { ask: "the security review finds nothing.", workflow: "Ship, step 4 of 5, a check" });
  assert.deepEqual(taskAsk("Add the prices API. It owns src/api.js."), { ask: "Add the prices API. It owns src/api.js.", workflow: "" });
});

test("an automation is told it may end quietly, and a run's bare NO_UPDATE is nothing new", async () => {
  const { promptFor } = await import("../src/automations.js");
  const { saysNoUpdate } = await import("../src/teammate-checkins.js");
  const told = promptFor({ name: "Morning news", does: "Check competitor news.", when: { kind: "manual" }, who: { tool: "claude", team: [], mode: "full", model: "", agentId: "" }, then: { pr: false, notify: true } } as never, "");
  assert.match(told, /reply with exactly NO_UPDATE and nothing else: the run ends quietly and nobody is told/);
  assert.ok(saysNoUpdate("NO_UPDATE") && saysNoUpdate(" NO_UPDATE. ") && !saysNoUpdate("NO_UPDATE, but one thing changed"));
});

test("a teammate's memory over a page is read from its newest part, with a word to tidy it", async () => {
  const { memoryText, MEMORY_MAX } = await import("../src/teammates.js");
  assert.equal(memoryText("- likes tabs\n"), "- likes tabs\n", "a page or less: as it is");
  const long = Array.from({ length: 400 }, (_, i) => `- fact ${i}: ${"x".repeat(20)}`).join("\n");
  const read = memoryText(long);
  assert.ok(read.length <= MEMORY_MAX, "never over a page");
  assert.match(read, /^\[Friday\] Your memory \(MEMORY\.md\) is [\d,]+ characters, over a page/);
  assert.ok(read.includes("- fact 399:"), "the newest kept");
  assert.ok(!read.includes("- fact 0:"), "the oldest left out");
  assert.match(read.split("\n\n")[1]!, /^- fact \d+:/, "from a line's start");
});
