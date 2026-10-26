import assert from "node:assert/strict";
import test from "node:test";
import { initials, tabOwner, tabState, tabWords } from "../src/client/agent-tab.js";

/** An agent's tab: whose it is in initials, where it stands in a word. */

test("someone else's agent shows its owner and drops them from the name", () => {
  assert.deepEqual(tabOwner("Arokia's Claude Code", null, "me"), { owner: "Arokia", name: "Claude Code" });
  assert.deepEqual(tabOwner("Claude Code", { id: "u2", name: "Arokia Raj" }, "me"), { owner: "Arokia Raj", name: "Claude Code" });
  assert.deepEqual(tabOwner("Arokia’s Codex", { id: "u2", name: "Arokia Raj" }, "me"), { owner: "Arokia Raj", name: "Codex" });
});

test("your own agent has no owner shown", () => {
  assert.deepEqual(tabOwner("Boss Man", { id: "me", name: "Maya Chen" }, "me"), { owner: null, name: "Boss Man" });
  assert.deepEqual(tabOwner("C2", null, "me"), { owner: null, name: "C2" });
});

test("states and their words", () => {
  assert.equal(tabState("working"), "working");
  assert.equal(tabState("waiting", true), "needs");
  assert.equal(tabState("ready"), "idle");
  assert.equal(tabState("offline"), "offline");
  assert.equal(tabState("limited"), "limited", "out of usage is its own, not a waiting amber");
  assert.equal(tabWords("limited", null, 0), "Out of usage");
  assert.equal(tabState(undefined), "idle");
  assert.equal(tabWords("working", 1000, 43_000), "Working · 42s");
  assert.equal(tabWords("working", 1000, 181_000), "Working · 3m");
  assert.equal(tabWords("needs", null, 0), "Needs you");
  assert.equal(initials("Arokia Raj"), "AR");
  assert.equal(initials("maya"), "M");
});

test("as many cards as the bar has room for, the rest behind +N", async () => {
  const { tabsThatFit } = await import("../src/client/agent-tab.js");
  // Three cards of 100 with gaps of 6 need 318; +N needs 60 more once one is left out.
  assert.equal(tabsThatFit([100, 100, 100], 400, 6, 60, 6), 3);
  assert.equal(tabsThatFit([100, 100, 100], 300, 6, 60, 6), 2);
  assert.equal(tabsThatFit([100, 100, 100, 100], 400, 6, 60, 6), 3, "three, with room kept for +1");
  assert.equal(tabsThatFit([100, 100, 100, 100, 100, 100, 100], 2000, 6, 60, 6), 6, "never more than the most shown");
  assert.equal(tabsThatFit([500], 100, 6, 60, 6), 1, "the one you are looking at is always a tab");
  assert.equal(tabsThatFit([100, 100, 100, 100, 100, 100, 100], 640, 6, 60, 6), 5, "six would leave none for +1");
});
