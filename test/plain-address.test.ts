import assert from "node:assert/strict";
import test from "node:test";
import { plainAddress, subTasksIn } from "../src/client/Tasks.js";
import type { SessionEvent } from "../src/types.js";

test("an address is shown as a person says it, not in the loopback form a machine answered on", () => {
  assert.equal(plainAddress("http://[::1]:5176/"), "localhost:5176");
  assert.equal(plainAddress("http://127.0.0.1:5173"), "localhost:5173");
  assert.equal(plainAddress("http://localhost:3000/docs"), "localhost:3000/docs");
  assert.equal(plainAddress("https://example.com/"), "example.com");
  assert.equal(plainAddress("not a url"), "not a url");
});

test("a subagent is listed once, where it stands now, with what it was started as", () => {
  const actor = { id: "engine:u", name: "Arun's Claude Code", kind: "agent" };
  const ev = (seq: number, body: object, lane?: string) => ({ seq, ts: seq * 1000, actor, body: { type: "agent.task", ...body }, ...(lane ? { lane } : {}) }) as SessionEvent;
  const [audit, other] = subTasksIn([
    ev(1, { id: "a", status: "running", description: "Audit the router", agentType: "general-purpose", background: true }),
    ev(2, { id: "a", status: "running", description: "Audit the router" }, "l2"),
    ev(5, { id: "a", status: "done", summary: "Found 2 bugs." }),
  ]);
  assert.deepEqual(audit, { key: "main:a", id: "a", lane: "main", by: "Arun's Claude Code", description: "Audit the router", agentType: "general-purpose", background: true, status: "done", summary: "Found 2 bugs.", start: 1000, seq: 1, opened: true, end: 5000, heard: 5000 });
  assert.equal(other!.lane, "l2", "the same id in another lane is another agent's");
  // A tool starting a turn reports on what its last session left behind, already over: not something this run sent off.
  const [left] = subTasksIn([ev(9, { id: "b", status: "stopped", summary: "Background shell command didn't finish before the previous session ended" })]);
  assert.equal(left!.opened, false);
  // One that was over before it was first reported still says what it was sent to do, and is this run's.
  const [quick] = subTasksIn([ev(9, { id: "c", status: "done", description: "Check the config", summary: "Fine." })]);
  assert.equal(quick!.opened, true);
});
