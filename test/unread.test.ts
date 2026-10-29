// Sessions that finished while you were elsewhere are marked in the sidebar until opened (Arun, 2026-10-28: "iron everything and
// ensure we are good… any logic errors and fixes").
import assert from "node:assert/strict";
import test from "node:test";
import { workingChanges } from "../src/client/unread.js";

test("between two looks: the sessions that stopped working, and the ones that started", () => {
  assert.deepEqual(workingChanges(new Set(["a", "b"]), new Set(["b", "c"])), { finished: ["a"], started: ["c"] });
  assert.deepEqual(workingChanges(new Set(), new Set()), { finished: [], started: [] });
});

test("a session's title from what was asked is cut at a word, with an ellipsis", async () => {
  const { titleFrom } = await import("../src/client/quick-send.js");
  assert.equal(titleFrom("W1 STEPS research the best launch day for a newsletter and write it up"), "W1 STEPS research the best launch day for a newsletter and…");
  assert.equal(titleFrom("  short\n title "), "short title");
  assert.ok(titleFrom("x".repeat(80)).length <= 60, "one long word is cut where it has to be");
});
