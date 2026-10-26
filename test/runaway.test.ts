import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FAILURES, runawayIn, runawayText } from "../src/runaway.js";
import type { EventBody, SessionEvent } from "../src/types.js";

let seq = 0;
const ev = (body: EventBody, lane?: string): SessionEvent => ({ seq: ++seq, ts: seq, actor: { id: "a", name: "Agent", kind: "agent" }, body, ...(lane ? { lane } : {}) });
const shell = (id: string, command: string) => ev({ type: "agent.message", text: "", toolCalls: [{ id, name: "shell", arguments: JSON.stringify({ command }) }] });
const result = (id: string, ok: boolean) => ev({ type: "tool.result", callId: id, name: "shell", output: ok ? "ok" : "Error: Cannot find module 'x'", isError: !ok });
const edit = (id: string) => ev({ type: "agent.message", text: "", toolCalls: [{ id, name: "edit", arguments: JSON.stringify({ path: "a.ts" }) }] });
const started = () => ev({ type: "run.started", causedBy: 1 });

test("the same failing command three times in a row, nothing changed between, is a loop", () => {
  const log = [started(), shell("1", "npm test"), result("1", false), shell("2", "npm  test"), result("2", false), shell("3", "npm test"), result("3", false)];
  assert.deepEqual(runawayIn(log, "main"), { command: "npm test", times: 3, kind: "stuck" });
  assert.match(runawayText(runawayIn(log, "main")!), /ran `npm test` 3 times in a row/);
});

test("running the tests again after changing something is ordinary work, until it has failed too often", () => {
  const log = [started()];
  for (let i = 0; i < MAX_FAILURES - 1; i++) log.push(shell(`c${i}`, "npm test"), result(`c${i}`, false), edit(`e${i}`));
  assert.equal(runawayIn(log, "main"), null, "edits between the failures: it's trying things");
  log.push(shell("last", "npm test"), result("last", false));
  assert.deepEqual(runawayIn(log, "main"), { command: "npm test", times: MAX_FAILURES, kind: "many" });
});

test("a pass breaks the streak, another lane's failures don't count, and a resume starts the count over", () => {
  const passed = [started(), shell("1", "npm test"), result("1", false), shell("2", "npm test"), result("2", true), shell("3", "npm test"), result("3", false), shell("4", "npm test"), result("4", false)];
  assert.equal(runawayIn(passed, "main"), null);
  const other = [started(), shell("1", "npm test"), result("1", false), shell("2", "npm test"), result("2", false), { ...shell("3", "npm test"), lane: "b" }, { ...result("3", false), lane: "b" }];
  assert.equal(runawayIn(other, "main"), null);
  const resumed = [started(), shell("1", "npm test"), result("1", false), shell("2", "npm test"), result("2", false), ev({ type: "run.resume" }), shell("3", "npm test"), result("3", false)];
  assert.equal(runawayIn(resumed, "main"), null, "a person said carry on");
});
