import assert from "node:assert/strict";
import test from "node:test";
import { changedRange, splitPath, splitRows, wordMarks } from "../src/client/diff-lines.js";
import type { DiffLine } from "../src/client/DiffView.js";

/**
 * The Diff panel's split view and its word marks: what a removed line became, and the part of it that changed.
 */
const ctx = (id: string, n: number, content: string): DiffLine => ({ id, type: "context", oldLine: n, newLine: n, content });
const del = (id: string, n: number, content: string): DiffLine => ({ id, type: "removed", oldLine: n, content });
const add = (id: string, n: number, content: string): DiffLine => ({ id, type: "added", newLine: n, content });

test("split rows pair each removed line with the added one that replaced it, and leave the rest on their own side", () => {
  const rows = splitRows([
    { id: "h", content: "@@ -1,4 +1,4 @@" },
    ctx("c1", 1, "import x"),
    del("d1", 2, "const a = 1;"),
    del("d2", 3, "const b = 2;"),
    add("a1", 2, "const a = 10;"),
    ctx("c2", 4, "export {}"),
    add("a2", 5, "// new"),
  ]);
  assert.deepEqual(
    rows.map((r) => ("hunk" in r ? "hunk" : `${r.left?.id ?? "-"}|${r.right?.id ?? "-"}`)),
    ["hunk", "c1|c1", "d1|a1", "d2|-", "c2|c2", "-|a2"],
  );
});

test("an addition before a removal is a change of its own, not paired across it", () => {
  const rows = splitRows([add("a1", 1, "x"), del("d1", 2, "y")]);
  assert.deepEqual(
    rows.map((r) => ("hunk" in r ? "hunk" : `${r.left?.id ?? "-"}|${r.right?.id ?? "-"}`)),
    ["-|a1", "d1|-"],
  );
});

test("the word mark covers what changed, widened to whole words, and nothing on a line rewritten end to end", () => {
  assert.deepEqual(changedRange("const total = price * qty;", "const total = price * count;"), { from: [22, 25], to: [22, 27] });
  assert.deepEqual(changedRange("if (count > max) {", "if (counter > max) {"), { from: [4, 9], to: [4, 11] }, "the whole word, not just \"er\"");
  assert.equal(changedRange("return a;", "throw new Error('nope');"), null);
  assert.equal(changedRange("same", "same"), null);
  const marks = wordMarks([del("d", 1, "slug.slice(0, max - 1)"), add("a", 1, "slug.slice(0, max)")]);
  assert.deepEqual(marks.get("d"), [14, 21], "\"max - 1\": from the start of the word the change begins in");
  assert.deepEqual(marks.get("a"), [14, 17], "\"max\"");
});

test("a path is the name a reader looks for and the folder it is in", () => {
  assert.deepEqual(splitPath("src/client/App.tsx"), { dir: "src/client/", name: "App.tsx" });
  assert.deepEqual(splitPath("README.md"), { dir: "", name: "README.md" });
});
