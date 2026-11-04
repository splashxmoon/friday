import assert from "node:assert/strict";
import test from "node:test";
import { history } from "../src/client/undo-stack.js";

// The workflow canvas had no undo: ⌘Z after dragging a wire went to the browser, which emptied the Name field (2026-11-04 retest).
test("undo goes back one change at a time, redo forward, and a new change forgets what was undone", () => {
  const h = history<string>();
  h.changed("a"); // a → b
  h.changed("b"); // b → c
  assert.equal(h.undo("c"), "b");
  assert.equal(h.undo("b"), "a");
  assert.equal(h.undo("a"), undefined);
  assert.equal(h.redo("a"), "b");
  h.changed("b"); // b → d
  assert.equal(h.redo("d"), undefined);
  assert.equal(h.undo("d"), "b");
});
