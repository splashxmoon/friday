import assert from "node:assert/strict";
import test from "node:test";
import { errorHead } from "../src/error-head.js";

const NODE = `node:fs:624
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^

Error: ENOENT: no such file or directory, open 'package.json'
    at readFileSync (node:fs:624:20)
    at turn (file:///tmp/claude-storm.mjs:192:28) {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: 'package.json'
}

Node.js v26.12.0`;

// Needs you showed a coding tool's whole stack trace in its card, and app.log and the [brain] line said only "node:fs:624"
// (2026-11-04 retest): the line that says what went wrong is the error's, not its first.
test("an error's head is the line that says what went wrong", () => {
  assert.equal(errorHead(NODE), "Error: ENOENT: no such file or directory, open 'package.json'");
  assert.equal(errorHead("error: unrecognized subcommand 'app-server'\n\nUsage: codex [OPTIONS]"), "error: unrecognized subcommand 'app-server'");
  assert.equal(errorHead("The folder disconnected."), "The folder disconnected.");
  assert.equal(errorHead("Traceback (most recent call last):\n  File \"x.py\", line 1\nValueError: bad value"), "ValueError: bad value");
  assert.equal(errorHead("x".repeat(300)).length, 200);
  assert.equal(errorHead(""), "");
});
