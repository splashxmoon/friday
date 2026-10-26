import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCall, doingNow } from "../src/activity-line.js";
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
