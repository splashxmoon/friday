import { test } from "node:test";
import assert from "node:assert/strict";
import { capDiff } from "../src/runner/git.js";

const file = (path: string, size: number) => ({ path, status: "added" as const, additions: 1, deletions: 0, patch: "x".repeat(size) });

test("a big file early in the list doesn't leave the small files after it empty", () => {
  const files = [file("huge.json", 60_000), ...Array.from({ length: 30 }, (_, i) => file(`big${i}.ts`, 30_000)), file("small.js", 2_000), file("tiny.js", 400)];
  const out = capDiff(files);
  const small = out.find((f) => f.path === "small.js")!;
  const tiny = out.find((f) => f.path === "tiny.js")!;
  assert.equal(small.truncated, undefined);
  assert.equal(small.patch.length, 2_000);
  assert.equal(tiny.patch.length, 400);
  assert.ok(out.reduce((n, f) => n + f.patch.length, 0) <= 600_000);
  // The cut falls on the biggest files, evenly, and none comes through empty.
  assert.ok(out.filter((f) => f.truncated).every((f) => f.patch.length > 0));
  // The list keeps its order.
  assert.deepEqual(out.map((f) => f.path), files.map((f) => f.path));
});

test("a change set under the room comes through whole", () => {
  const out = capDiff([file("a.ts", 100), file("b.ts", 50_000)]);
  assert.ok(out.every((f) => !f.truncated));
});
