import assert from "node:assert/strict";
import test from "node:test";
import { reviewText } from "../src/client/review.js";
import { threadPrompt } from "../src/threads.js";

test("Notes on a block: the review message names the range and fences the block, and a single line stays inline", () => {
  const text = reviewText([
    { path: "src/streak.ts", line: 12, endLine: 15, removed: false, code: "const a = 1;\nconst b = 2;\nreturn a + b;", text: "Pull this into one helper." },
    { path: "src/streak.ts", line: 3, removed: false, code: "import x from 'y';", text: "Unused." },
  ]);
  assert.match(text, /^Review of your changes/);
  const lines = text.split("\n");
  // Sorted by line: the single line first, inline.
  assert.match(lines[2]!, /^- src\/streak\.ts:3 — `import x from 'y';`$/);
  assert.equal(lines[3], "  Unused.");
  assert.equal(lines[4], "- src/streak.ts:12–15");
  assert.equal(lines[5], "  ```");
  assert.equal(lines[6], "  const a = 1;");
  assert.equal(lines[8], "  return a + b;");
  assert.equal(lines[9], "  ```");
  assert.equal(lines[10], "  Pull this into one helper.");
});

test("Notes on a block: the agent is told the range, and that removed lines were lines", () => {
  const base = { path: "a.ts", code: "x\ny", text: "Why both?", by: { id: "u", name: "Arun" }, replies: [] };
  assert.match(threadPrompt({ ...base, line: 4, endLine: 5, removed: false }), /left a review comment on a\.ts:4–5\./);
  assert.match(threadPrompt({ ...base, line: 4, endLine: 5, removed: true }), /the lines that were removed at a\.ts:4–5\./);
  assert.match(threadPrompt({ ...base, line: 4, removed: false }), /on a\.ts:4\./);
  // An end line no further than the start is not a range.
  assert.match(threadPrompt({ ...base, line: 4, endLine: 4, removed: false }), /on a\.ts:4\./);
});
