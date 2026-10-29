import assert from "node:assert/strict";
import test from "node:test";
import { patchLines } from "../src/client/patchLines.js";

// 2026-10-28 QA (Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"): a file whose patch had no hunk header showed an
// empty card under a header counting its lines.

test("a patch with hunk headers numbers its lines from them", () => {
  const rows = patchLines("@@ -3,2 +3,2 @@\n-a\n+b\n c");
  assert.deepEqual(rows.map((r) => [r.type, r.oldLine, r.newLine, r.content]), [
    ["context", undefined, undefined, "@@"],
    ["removed", 3, undefined, "a"],
    ["added", undefined, 3, "b"],
    ["context", 4, 4, "c"],
  ]);
});

test("a bare patch, only its + and − lines, is one hunk from line 1", () => {
  const rows = patchLines('+test("a 9 PM event keeps its day", () => {});\n+// two\n');
  assert.deepEqual(rows.map((r) => [r.type, r.newLine]), [["added", 1], ["added", 2]]);
});

test("a bare patch's file headers are not lines of the file", () => {
  assert.deepEqual(patchLines("--- a/x\n+++ b/x\n+new").map((r) => r.content), ["new"]);
});

test("an empty patch, or one with no changed line, draws nothing", () => {
  assert.deepEqual(patchLines(""), []);
  assert.deepEqual(patchLines("Binary files differ"), []);
});
