import assert from "node:assert/strict";
import test from "node:test";
import { LOGGED_DIFF_TOTAL, LOGGED_FILE_PATCH, leanDiff } from "../src/engine/hub.js";
import type { DiffFile } from "../src/types.js";

/** A change set as the log keeps it (hub.ts leanDiff): names and counts always, patches within a budget, no binary bytes. */

const file = (path: string, patch: string): DiffFile => ({ path, status: "modified", additions: 1, deletions: 0, patch });

test("a logged change set keeps every file, a small patch whole, a big one cut at a line, and no binary file's bytes", () => {
  const big = Array.from({ length: 2000 }, (_, i) => `+line ${i} ${"x".repeat(20)}`).join("\n");
  const d = leanDiff({ type: "agent.diff", base: "b", files: [file("a.ts", "+one\n+two"), file("big.ts", big), file("model.onnx", "+\u0000\u0001onnx"), file("logo.png", "GIT binary patch\nliteral 12")] });
  assert.deepEqual(d.files.map((f) => f.path), ["a.ts", "big.ts", "model.onnx", "logo.png"]);
  assert.equal(d.files[0]!.patch, "+one\n+two");
  assert.equal(d.files[0]!.truncated, undefined);
  assert.ok(d.files[1]!.patch.length <= LOGGED_FILE_PATCH && d.files[1]!.truncated);
  assert.ok(d.files[1]!.patch.endsWith(`${"x".repeat(20)}`), "cut at the end of a line");
  assert.deepEqual([d.files[2]!.patch, d.files[2]!.truncated, d.files[3]!.patch], ["", true, ""]);
  // Fifty big files: the whole set stays within its budget.
  const many = leanDiff({ type: "agent.diff", base: "b", files: Array.from({ length: 50 }, (_, i) => file(`f${i}.ts`, big)) });
  assert.ok(many.files.reduce((n, f) => n + f.patch.length, 0) <= LOGGED_DIFF_TOTAL);
  assert.equal(many.files.length, 50);
});
