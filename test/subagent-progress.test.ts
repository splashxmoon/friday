import { test } from "node:test";
import assert from "node:assert/strict";
import { claude, subagentDoing, type AdapterOut } from "../src/runner/adapters.js";

const run = (p: (l: string) => AdapterOut[], lines: object[]) => lines.flatMap((l) => p(JSON.stringify(l)));
const step = (parent: string, name: string, input: object) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id: `u-${Math.random()}`, name, input }] },
});

test("a subagent's own steps say what it is doing and how many it has taken, now and then, and the count when it is back", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const p = claude.parser();
  const tasks = (out: AdapterOut[]) => out.filter((o): o is Extract<AdapterOut, { kind: "task" }> => o.kind === "task");

  const started = tasks(run(p, [{ type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_9", description: "Audit the sidebar", subagent_type: "Explore", task_type: "local_agent" }]));
  assert.equal(started[0]?.status, "running");

  // Its first step is said at once.
  const first = tasks(run(p, [step("toolu_9", "Read", { file_path: "/repo/src/client/Sidebar.tsx" })]));
  assert.deepEqual(first, [{ kind: "task", id: "a1", status: "running", doing: "Reading Sidebar.tsx", steps: 1 }]);

  // The next ones within a few seconds are counted, not said.
  assert.deepEqual(tasks(run(p, [step("toolu_9", "Grep", { pattern: "tabIndex" }), step("toolu_9", "Bash", { command: "npm test", description: "Run the tests" })])), []);

  // Later, the latest step and the count so far.
  t.mock.timers.tick(5000);
  const later = tasks(run(p, [step("toolu_9", "Bash", { command: "npm test" })]));
  assert.deepEqual(later, [{ kind: "task", id: "a1", status: "running", doing: "Running npm test", steps: 4 }]);

  // A step of something that isn't one of its subagents says nothing.
  assert.deepEqual(tasks(run(p, [step("toolu_other", "Read", { file_path: "x.ts" })])), []);

  // Back: how it ended, with what it found and how many steps it took.
  const back = tasks(run(p, [{ type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "toolu_9", status: "completed", summary: "Two problems." }]));
  assert.deepEqual(back, [{ kind: "task", id: "a1", status: "done", summary: "Two problems.", steps: 4 }]);
});

test("a subagent's step is said in a few plain words", () => {
  assert.equal(subagentDoing({ name: "edit", args: { path: "src/a/b.ts" } }), "Editing b.ts");
  assert.equal(subagentDoing({ name: "web_search", args: { query: "claude code subagents" } }), "Searching the web for claude code subagents");
  assert.equal(subagentDoing({ name: "web_fetch", args: { url: "https://www.example.com/docs" } }), "Reading example.com/docs");
  assert.equal(subagentDoing({ name: "mcp__linear__get_issue", args: {} }), "Using linear get_issue");
});

test("a command is said by what it runs, not by the imperative it was described with", () => {
  assert.equal(subagentDoing({ name: "shell", args: { command: "npm test -- --reporter dot", description: "Run the tests" } }), "Running npm test -- --reporter dot");
});

test("the subagents' tally says stopped ones apart: not back, and never \"All back\" for a set that was stopped", async () => {
  const { tallyOf } = await import("../src/client/Subagents.js");
  const r = (state: "working" | "done" | "blocked" | "open") => ({ key: state, description: state, state });
  assert.equal(tallyOf([r("done"), r("done")]).text, "All back");
  assert.equal(tallyOf([r("done"), r("open")]).text, "1 back · 1 stopped");
  assert.equal(tallyOf([r("open"), r("open")]).text, "2 stopped");
  assert.equal(tallyOf([r("working"), r("open"), r("blocked")]).text, "1 working · 1 stopped · 1 failed");
});

test("a failed subagent says why, or what it was doing; one at work and silent a long while says it may be stuck", async () => {
  const { subagentLine, QUIET_MS } = await import("../src/client/Subagents.js");
  const { subTasksIn } = await import("../src/client/Tasks.js");
  const now = 1_000_000_000;
  assert.deepEqual(subagentLine({ state: "blocked", summary: "npm ERR! missing script: test" }, now), { text: "Failed: npm ERR! missing script: test", tone: "bad" });
  assert.equal(subagentLine({ state: "blocked", doing: "Running npm test" }, now)?.text, "Failed while running npm test");
  assert.equal(subagentLine({ state: "blocked" }, now)?.text, "Failed, and its tool didn't say why");
  assert.equal(subagentLine({ state: "working", doing: "Reading a.ts", heard: now - 60_000 }, now)?.text, "Reading a.ts");
  const quiet = subagentLine({ state: "working", doing: "Reading a.ts", heard: now - QUIET_MS - 1000 }, now)!;
  assert.equal(quiet.tone, "warn");
  assert.match(quiet.text, /it may be stuck/);
  // What it was doing as it failed is kept from its last report.
  const ev = (seq: number, body: object) => ({ seq, ts: seq, lane: "main", actor: { id: "a", name: "Claude Code", kind: "agent" }, body: { type: "agent.task", id: "t1", ...body } }) as never;
  const [t] = subTasksIn([ev(1, { status: "running", description: "Profile", doing: "Running the profiler" }), ev(2, { status: "error" })]);
  assert.equal(t!.doing, "Running the profiler");
  assert.equal(t!.heard, 2);
});
