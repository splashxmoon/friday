import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCall, doingNow, isRawError, stoppedDetail, stoppedLine, stoppedRow } from "../src/activity-line.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const ev = (seq: number, body: EventBody, lane?: string): SessionEvent => ({ seq, ts: seq * 1000, actor: { id: "a", name: "A" } as SessionEvent["actor"], body, ...(lane ? { lane } : {}) });
const tc = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });
const step = (seq: number, calls: ReturnType<typeof tc>[], text = "", lane?: string) => ev(seq, { type: "agent.message", text, toolCalls: calls }, lane);
const result = (seq: number, callId: string, lane?: string) => ev(seq, { type: "tool.result", callId, name: "x", output: "ok", isError: false }, lane);
const start = (seq: number, lane?: string) => ev(seq, { type: "run.started", causedBy: 0 }, lane);
const end = (seq: number, lane?: string) => ev(seq, { type: "run.ended", outcome: "done" }, lane);

test("a tool call is said in the present tense, with the part of the path a person recognises", () => {
  assert.equal(describeCall(tc("1", "read_file", { path: "src/server/routes/billing.ts" })), "Reading routes/billing.ts");
  assert.equal(describeCall(tc("1", "edit_file", { path: "app.ts" })), "Editing app.ts");
  assert.equal(describeCall(tc("1", "run_command", { command: "npm test -- --watch=false" })), "Running npm test -- --watch=false");
  assert.equal(describeCall(tc("1", "search_code", { query: "PORT" })), "Searching the code for “PORT”");
  assert.equal(describeCall(tc("1", "web_search", { query: "node 24 release date" })), "Searching the web for “node 24 release date”");
  assert.equal(describeCall(tc("1", "update_plan", {})), "Updating its plan");
  assert.equal(describeCall(tc("1", "mcp__linear__create_issue", {})), "Using linear: create issue");
  assert.equal(describeCall(tc("1", "some_new_tool", {})), "Using some new tool");
  assert.equal(describeCall({ name: "read_file", arguments: "not json" }), "Reading a file");
});

test("long commands are cut, not dumped", () => {
  const t = describeCall(tc("1", "run_command", { command: "x".repeat(300) }));
  assert.ok(t.length < 70, t);
  assert.ok(t.endsWith("…"));
});

test("what it is doing is the call still waiting on its result", () => {
  const log = [start(1), step(2, [tc("a", "read_file", { path: "a.ts" }), tc("b", "run_command", { command: "npm test" })]), result(3, "a")];
  assert.equal(doingNow(log, "main")!.text, "Running npm test");
  assert.equal(doingNow(log, "main")!.steps, 1);
});

test("with every result back it is deciding, with only words it is answering, with nothing yet it is starting", () => {
  const back = [start(1), step(2, [tc("a", "read_file", { path: "a.ts" })]), result(3, "a")];
  assert.equal(doingNow(back, "main")!.text, "Thinking about what to do next");
  assert.equal(doingNow([start(1), step(2, [], "Here is what I found")], "main")!.text, "Writing its answer");
  assert.equal(doingNow([start(1)], "main")!.text, "Getting started");
});

test("a lane that is not in a run is doing nothing, and lanes do not borrow each other's steps", () => {
  assert.equal(doingNow([start(1), step(2, [tc("a", "read_file", { path: "a.ts" })]), end(3)], "main"), null);
  assert.equal(doingNow([], "main"), null);
  const two = [start(1), step(2, [tc("a", "edit_file", { path: "x.ts" })]), start(3, "rev"), step(4, [tc("b", "run_command", { command: "lint" })], "", "rev")];
  assert.equal(doingNow(two, "main")!.text, "Editing x.ts");
  assert.equal(doingNow(two, "rev")!.text, "Running lint");
  assert.equal(doingNow([...two, end(5, "rev")], "rev"), null);
  assert.equal(doingNow([...two, end(5, "rev")], "main")!.text, "Editing x.ts", "one lane ending does not end another");
});

test("subagents still out are what it is doing, not \"Using Task\" or thinking (Arun, 2026-10-28: \"iron everything\")", () => {
  const two = [start(1), step(2, [tc("t1", "Task", { description: "Map the flow" }), tc("t2", "Task", { description: "Review the tests" })])];
  assert.equal(doingNow(two, "main")!.text, "Waiting on 2 subagents");
  const one = [start(1), step(2, [tc("t1", "Task", { description: "Map the flow" })])];
  assert.equal(doingNow(one, "main")!.text, "Waiting on a subagent: Map the flow");
  // Its own read came back meanwhile: still waiting on them, not "Thinking about what to do next".
  const read = [...two, step(3, [tc("r", "read_file", { path: "a.json" })]), result(4, "r")];
  assert.equal(doingNow(read, "main")!.text, "Waiting on 2 subagents");
  // Its own step in flight is said as itself.
  assert.equal(doingNow([...two, step(3, [tc("r", "read_file", { path: "a.json" })])], "main")!.text, "Reading a.json");
  assert.equal(doingNow([...one, result(3, "t1"), step(4, [], "")], "main")!.text, "Thinking");
});

// A live line is a short status in words, never a tool's raw error (Arun, 2026-10-29: a teammate's needs-you line in the sidebar read
// "node:internal/modules/cjs/loader:1…").
test("a stopped run says what it means in words, and keeps an error that already is words", () => {
  const crash = "node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '/x/cli.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)";
  assert.equal(isRawError(crash), true);
  assert.equal(stoppedLine(crash), "Stopped: their tool failed to start");
  assert.equal(stoppedLine("TypeError: Cannot read properties of undefined (reading 'map') at run (src/app.ts:12:5)"), "Stopped on an error");
  assert.equal(stoppedLine("Error: 3 failing tests in cart.test.ts:40"), "Stopped: tests failed");
  for (const plain of ["The folder disconnected.", "Claude Code didn't start (dry run)", "[Friday] Out of credits"]) {
    assert.equal(isRawError(plain), false, plain);
    assert.equal(stoppedLine(plain), plain);
  }
  assert.equal(stoppedLine(""), "Stopped on an error");
});

// A tool that worked and then hit an error didn't fail to start (audit CODE-4, Arun 2026-11-04), and one out of usage says
// until when, never "Stopped on an error" (audit CODE-5).
test("a stopped agent's row says what happened, not that its tool failed to start", () => {
  const midTurn = "node:fs:624 return binding.readFileUtf8(path, stringToFlags(options.flag));\n ^\nError: ENOENT: no such file or directory, open 'package.json'\n    at readFileSync (node:fs:624:20)\n    at turn (file:///x/claude-storm.mjs:192:28) { errno: -2, code: 'ENOENT', syscall: 'open', path: 'package.json' }";
  assert.equal(stoppedLine(midTurn), "Stopped on an error");
  assert.equal(stoppedRow("Claude Code", midTurn), "Claude Code stopped with an error");
  assert.equal(stoppedLine("Error: spawn claude ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)"), "Stopped: their tool failed to start");
  assert.equal(stoppedRow("Codex", "node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module 'x'"), "Codex stopped: their tool failed to start");
  assert.equal(stoppedRow("Kit", "The folder disconnected."), "Kit stopped: The folder disconnected.");
  const now = new Date(2026, 10, 4, 10, 0).getTime();
  assert.match(stoppedRow("Claude Code", "5-hour limit reached ∙ resets 3pm", now), /^Claude Code · Out of usage until 3\sPM$/);
  assert.equal(stoppedRow("Claude Code", "Claude AI usage limit reached|1000000000", now), "Claude Code · Out of usage");
});

// The first line of a crash, as a session's row keeps it ("node:fs:624"), is still a raw error (audit CODE-4).
test("a crash's first line alone is still raw", () => {
  assert.equal(isRawError("node:fs:624"), true);
  assert.equal(stoppedRow("Claude Code", "node:fs:624"), "Claude Code stopped with an error");
});

// Right now and the board say a stopped run as the row does (audit CODE-17 A/B, CODE-5).
test("a stopped run's detail where its agent is already named", () => {
  const now = new Date(2026, 10, 4, 10, 0).getTime();
  assert.equal(stoppedDetail("node:fs:624\nError: ENOENT: no such file or directory, open 'package.json'", now), "Stopped with an error");
  assert.match(stoppedDetail("5-hour limit reached ∙ resets 3pm", now), /^Out of usage until 3\sPM$/);
  assert.equal(stoppedDetail("The folder disconnected.", now), "Stopped: The folder disconnected.");
});
