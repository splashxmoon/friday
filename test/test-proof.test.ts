import assert from "node:assert/strict";
import { test } from "node:test";
import { countsLine, tailOf, testCounts, testRunsIn } from "../src/test-proof.js";
import type { SessionEvent } from "../src/types.js";

test("testCounts reads the summary of the runners people use", () => {
  assert.deepEqual(testCounts("Tests:       2 failed, 1 skipped, 140 passed, 143 total"), { passed: 140, failed: 2, skipped: 1 });
  assert.deepEqual(testCounts(" Test Files  1 passed (1)\n      Tests  2 failed | 140 passed (142)\n"), { passed: 140, failed: 2 });
  assert.deepEqual(testCounts("ℹ tests 9\nℹ pass 9\nℹ fail 0\n"), { passed: 9, failed: 0 });
  assert.deepEqual(testCounts("# pass 140\n# fail 2\n"), { passed: 140, failed: 2 });
  assert.deepEqual(testCounts("===== 2 failed, 140 passed, 1 skipped in 3.21s ====="), { passed: 140, failed: 2, skipped: 1 });
  assert.deepEqual(testCounts("test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured"), { passed: 12, failed: 0, skipped: 1 });
  assert.deepEqual(testCounts("143 examples, 2 failures, 1 pending"), { passed: 140, failed: 2, skipped: 1 });
  assert.deepEqual(testCounts("nothing a runner said"), {});
});

test("tailOf keeps the end, colour codes off", () => {
  assert.equal(tailOf("a\nb\n\u001b[31mc\u001b[0m\n", 2), "b\nc");
  assert.equal(tailOf("x".repeat(5000)).length, 2500);
});

test("countsLine", () => {
  assert.equal(countsLine({ passed: 140, failed: 2, ms: 12_400 }), "140 passed · 2 failed · 12.4s");
  assert.equal(countsLine({ passed: 9, failed: 0, ms: 800 }), "9 passed · 800ms");
  assert.equal(countsLine({ ms: 125_000 }), "2m 5s");
});

const call = (seq: number, id: string, command: string): SessionEvent =>
  ({ seq, ts: seq * 1000, actor: { id: "a", name: "Claude Code", kind: "agent" }, body: { type: "agent.message", text: "", toolCalls: [{ id, name: "run_command", arguments: JSON.stringify({ command }) }] } }) as unknown as SessionEvent;
const result = (seq: number, id: string, output: string, isError = false): SessionEvent =>
  ({ seq, ts: seq * 1000 + 500, actor: { id: "a", name: "Claude Code", kind: "agent" }, body: { type: "tool.result", callId: id, name: "run_command", output, isError } }) as unknown as SessionEvent;

test("testRunsIn: each test command's last attempt, a fixed failure as a pass, other commands left out", () => {
  const events = [
    call(1, "c1", "npm test 2>&1 | tail -40"),
    result(2, "c1", "$ npm test\n(exited 1)\n✖ cart total rounds (1ms)\n# pass 8\n# fail 1\n", true),
    call(3, "c2", "ls src"),
    result(4, "c2", "$ ls src\n(exited 0)\na.ts"),
    call(5, "c3", "npm test"),
    result(6, "c3", "$ npm test\n(exited 0)\n# pass 9\n# fail 0\n"),
  ];
  const runs = testRunsIn(events, "main", 0, 10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.command, "npm test");
  assert.equal(runs[0]!.ok, true);
  assert.equal(runs[0]!.passed, 9);
  const failedOnly = testRunsIn(events.slice(0, 2), "main", 0, 10);
  assert.equal(failedOnly[0]!.ok, false);
  assert.deepEqual(failedOnly[0]!.failing, ["cart total rounds"]);
  assert.equal(failedOnly[0]!.failed, 1);
});

test("durationIn reads the runner's own time", async () => {
  const { durationIn } = await import("../src/test-proof.js");
  assert.equal(durationIn("ℹ tests 3\nℹ duration_ms 212.5\n"), 213);
  assert.equal(durationIn("Time:        3.2 s\n"), 3200);
  assert.equal(durationIn("===== 3 passed in 1.50s ====="), 1500);
  assert.equal(durationIn("   Duration  840ms (transform 20ms)"), 840);
  assert.equal(durationIn("nothing"), undefined);
});

test("testRunsIn: a run that never reached the tests is left out, a non-zero exit is a failure", () => {
  const never = [call(1, "c1", "timeout 600 cargo test"), result(2, "c1", "(eval):1: command not found: timeout\nShell cwd was reset to /tmp")];
  assert.equal(testRunsIn(never, "main", 0, 10).length, 0);
  const exited = [call(1, "c1", "npm test"), result(2, "c1", "$ npm test\n(exited 1)\nsomething broke")];
  assert.equal(testRunsIn(exited, "main", 0, 10)[0]!.ok, false);
  const failedCount = [call(1, "c1", "cargo test"), result(2, "c1", "$ cargo test\ntest result: FAILED. 3 passed; 1 failed; 0 ignored")];
  assert.equal(testRunsIn(failedCount, "main", 0, 10)[0]!.ok, false);
});

test("testPart and cargo workspaces", async () => {
  const { testPart } = await import("../src/test-proof.js");
  assert.equal(testPart("git status --short && cargo test -q -p reel-core"), "cargo test -q -p reel-core");
  assert.equal(testPart("cd /x/y && npm test"), "npm test");
  assert.equal(testPart("ls"), "ls");
  assert.deepEqual(testCounts("test result: ok. 10 passed; 0 failed; 0 ignored\ntest result: ok. 3 passed; 1 failed; 2 ignored"), { passed: 13, failed: 1, skipped: 2 });
});
