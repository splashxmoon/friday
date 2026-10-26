import assert from "node:assert/strict";
import test from "node:test";
import { shortPaths } from "../src/client/shortPaths.js";

test("a file address in a stop reason shows as its last part, decoded, and a clipped escape never throws", () => {
  assert.equal(shortPaths("Claude Code stopped: file:///C:/Users/ARUNDA%7E1/AppData/notes%20draft.md"), "Claude Code stopped: notes draft.md");
  // Clipped inside "%7E": the raw piece, not a crash that blanks the board.
  assert.equal(shortPaths("file:///C:/Users/ARUNDA%7"), "ARUNDA%7");
  assert.equal(shortPaths("Lost its connection when the server restarted."), "Lost its connection when the server restarted.");
});

test("a crashed tool's terminal colour codes are dropped, not shown", () => {
  const stack = "SyntaxError: Invalid token \u001b[90m    at compileSourceTextModule (node:internal/modules/esm/utils:346:16)\u001b[39m";
  assert.equal(shortPaths(stack), "SyntaxError: Invalid token     at compileSourceTextModule (node:internal/modules/esm/utils:346:16)");
  assert.equal(shortPaths("\u001b[1;31mFailed\u001b[0m and \u001b[2K\u001b[1Gcleared"), "Failed and cleared");
  assert.equal(shortPaths("a lone \u001b escape"), "a lone  escape");
});
