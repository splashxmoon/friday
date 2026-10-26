import assert from "node:assert/strict";
import test from "node:test";
import { editPreview, failingTests, foldLine } from "../src/step-extras.js";

/**
 * More signal per step: failing test names, edit previews, and a run folded to one line.
 */

test("failing tests are named from the runners people use, once each, at most eight", () => {
  const tap = "ok 1 - adds\nnot ok 2 - subtracts\n# Subtest: x\nnot ok 3 - divides by zero\nnot ok 2 - subtracts\n";
  assert.deepEqual(failingTests(tap), ["subtracts", "divides by zero"]);
  const jest = "\x1b[31m  ✕ renders the toggle (12 ms)\x1b[0m\n  ✓ renders the label (3 ms)\n  × handles empty input\nFAIL src/toggle.test.tsx\n";
  assert.deepEqual(failingTests(jest), ["renders the toggle", "handles empty input", "src/toggle.test.tsx"]);
  assert.deepEqual(failingTests("FAILED tests/test_a.py::test_round - AssertionError\n--- FAIL: TestSum (0.00s)\ntest parse::empty ... FAILED\n  1) saves the draft"), ["tests/test_a.py::test_round", "TestSum", "parse::empty", "saves the draft"]);
  assert.equal(failingTests(Array.from({ length: 12 }, (_, i) => `not ok ${i} - t${i}`).join("\n")).length, 8);
  assert.deepEqual(failingTests("all 12 passed"), []);
});

test("an edit's own arguments give the lines it took out and put in; a whole file gives its first lines", () => {
  assert.deepEqual(editPreview({ path: "a.ts", find: "const a = 1;\nconst b = 2;\n\nconst c = 3;\nconst d = 4;", content: "const a = 10;" }), { old: ["const a = 1;", "const b = 2;", "const c = 3;"], new: ["const a = 10;"] });
  assert.deepEqual(editPreview({ old_string: "x", new_string: "y" }), { old: ["x"], new: ["y"] });
  assert.deepEqual(editPreview({ path: "new.ts", content: "export const n = 1;\n\nexport const m = 2;" }), { old: [], new: ["export const n = 1;", "export const m = 2;"] });
  assert.equal(editPreview({ path: "a.ts" }), null);
  assert.equal(editPreview({ find: "", content: "   " }), null);
});

test("a finished run folds to the facts that decide whether to open it", () => {
  assert.equal(foldLine({ changed: 3, tests: "pass", failed: 0, ms: 125_000 }), "Edited 3 files · tests passed · 2m");
  assert.equal(foldLine({ changed: 1, tests: "fail", failed: 2, ms: 40_000 }), "Edited 1 file · tests failed · 2 commands failing · 40s");
  assert.equal(foldLine({ changed: 0, tests: null, failed: 0, ms: 3000, answer: "## Changes made\nFixed the off-by-one." }), "Changes made · 3s");
  assert.equal(foldLine({ changed: 0, tests: null, failed: 0, ms: 0 }), "Worked");
});
