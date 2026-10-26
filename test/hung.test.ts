import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { HUNG_CPU_S, cpuSeconds, firstWordMs, hungMs, isHung, neverStarted, treeCpu, treeSeconds } from "../src/runner/hung.js";

/**
 * A coding tool that has said nothing and run nothing for twenty minutes is hung, not busy: Codex sat eight hours on a model
 * call that never came back. One that is quiet but working (a build, a test suite) is left alone.
 */

test("CPU time reads as ps prints it, on a Mac and on Linux", () => {
  assert.equal(cpuSeconds("0:09.97"), 9.97);
  assert.equal(cpuSeconds("591:36.57"), 591 * 60 + 36.57, "a Mac counts minutes past sixty");
  assert.equal(cpuSeconds("02:03:04"), 2 * 3600 + 3 * 60 + 4);
  assert.equal(cpuSeconds("1-02:03:04"), 86_400 + 2 * 3600 + 3 * 60 + 4);
  assert.ok(Number.isNaN(cpuSeconds("?")));
});

test("a tool's CPU is its own and everything it started, and nothing else's", () => {
  const table = [
    "    1     0  31:29.22",
    "  500     1   0:09.97", // the tool
    "  501   500   0:00.27", // its MCP server
    "  502   500   1:00.00", // a command it ran
    "  503   502   0:30.00", // something that command started
    "  600     1  10:00.00", // somebody else's
  ].join("\n");
  assert.equal(treeSeconds(table, 500), 9.97 + 0.27 + 60 + 30);
  assert.equal(treeSeconds(table, 999), null, "gone: nothing to say about it");
});

test("hung is silent for twenty minutes and idle over the last ten; busy, waiting or unknown never is", () => {
  assert.equal(isHung(hungMs(), 10.5, 10.9), true, "Codex waiting on a call that never came back");
  assert.equal(isHung(hungMs(), 10, 10 + HUNG_CPU_S + 120), false, "quiet, but a test suite is running");
  assert.equal(isHung(hungMs() - 60_000, 10, 10), false, "not quiet long enough yet");
  assert.equal(isHung(hungMs(), null, 10), false, "no reading from a window ago (it spoke since, or was waiting on someone)");
  assert.equal(isHung(hungMs(), 10, null), false, "a computer where it can't be told (Windows)");
});

test("a turn with no word from its tool after five minutes, idle all the while, never started; one that is working did", () => {
  assert.equal(firstWordMs(), 5 * 60_000);
  assert.equal(neverStarted(firstWordMs(), 4.2, 4.6), true, "Codex handed a review and never answering");
  assert.equal(neverStarted(firstWordMs(), 4, 4 + HUNG_CPU_S + 30), false, "silent but busy: it is working on something");
  assert.equal(neverStarted(firstWordMs() - 1000, 4, 4), false, "not long enough yet");
  assert.equal(neverStarted(firstWordMs(), null, 4), false, "no reading at the start");
  assert.equal(neverStarted(firstWordMs(), 4, null), false, "a computer where it can't be told (Windows)");
});

test("the CPU of a real process tree can be read", { skip: process.platform === "win32" }, async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((r) => setTimeout(r, 300));
  const s = await treeCpu(child.pid);
  assert.ok(s !== null && s >= 0 && s < 30, `an idle node uses little (${s})`);
  assert.equal(await treeCpu(undefined), null);
});
