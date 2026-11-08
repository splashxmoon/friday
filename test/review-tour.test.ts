// Code Review's guided tour (ReviewTour.tsx; Arun, 2026-11-07: "fix the guided tour it is bugged and poorly designed"): a file's
// diff read into numbered lines, so a finding's line can be found in it.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./fake-dom.js";

const { diffLines } = await import("../src/client/ReviewTour.js");

test("a patch reads as numbered lines: added and kept by the new file, taken away by the old", () => {
  const lines = diffLines(["@@ -10,3 +10,4 @@ services:", "   api:", "-    restart: always", "+    restart: unless-stopped", "+    healthcheck: {}", "     ports:", "\\ No newline at end of file"].join("\n"));
  assert.deepEqual(
    lines.map((l) => [l.kind, l.n ?? null]),
    [["hunk", null], ["same", 10], ["del", 11], ["add", 11], ["add", 12], ["same", 13]],
  );
  assert.equal(lines[0]!.text, "services:");
  assert.equal(lines[3]!.text, "    restart: unless-stopped");
});

test("a second hunk starts its numbers where GitHub says", () => {
  const lines = diffLines(["@@ -1,1 +1,1 @@", "-a", "+b", "@@ -40,2 +42,2 @@ volumes:", " data:", "-x", "+y"].join("\n"));
  assert.deepEqual(lines.slice(3).map((l) => l.n ?? null), [null, 42, 41, 43]);
});
