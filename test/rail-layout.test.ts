// The rail's places (rail-layout.ts): one order, each shown on the rail or behind its ⋯. What was kept is made whole (the first
// version's lists and lines read too), Sessions is always shown, and the moves the panel and the right-click make.
import assert from "node:assert/strict";
import test from "node:test";
import { hiddenOf, moveInRail, normalizeRail, placeAt, RAIL_DEFAULT, setShown, shownOf } from "../src/client/rail-layout.js";

test("kept layouts are made whole; the first version's are read; Sessions is shown", () => {
  assert.deepEqual(normalizeRail(null), RAIL_DEFAULT);
  assert.deepEqual(normalizeRail("junk"), RAIL_DEFAULT);
  assert.deepEqual(shownOf(RAIL_DEFAULT), ["sessions", "agents", "needs", "automations", "review"]);
  assert.deepEqual(hiddenOf(RAIL_DEFAULT), ["board", "deepdive", "mcp", "skills"]);
  // The first version: the rail's list with lines and a place since gone, then the ⋯'s.
  const old = normalizeRail({ rail: ["today", "review", "sessions", "sep", "skills"], more: ["agents", "board"] });
  assert.deepEqual(shownOf(old).slice(0, 3), ["review", "sessions", "skills"]);
  assert.ok(old.hidden.includes("agents") && old.hidden.includes("board"));
  assert.equal(old.order.length, 9, "every place once, none unknown");
  // Sessions can't be hidden; a place never kept goes where it goes by default.
  const kept = normalizeRail({ order: ["review", "sessions"], hidden: ["sessions", "review"] });
  assert.ok(!kept.hidden.includes("sessions"));
  assert.ok(kept.hidden.includes("review"));
  assert.ok(kept.hidden.includes("skills"), "skills, not kept, behind the ⋯ as by default");
});

test("moves: a step among its neighbours, a drag to another's place, shown or not", () => {
  const l = RAIL_DEFAULT;
  assert.deepEqual(shownOf(moveInRail(l, "agents", -1)).slice(0, 2), ["agents", "sessions"]);
  assert.equal(moveInRail(l, "sessions", -1), l, "nothing above the first");
  // A step skips what's on the other side of the ⋯, and what this window doesn't offer.
  assert.deepEqual(shownOf(moveInRail(l, "review", 1)), shownOf(l), "the last on the rail stays last");
  const noDive = (p: string) => p !== "deepdive";
  assert.deepEqual(hiddenOf(moveInRail(l, "mcp", -1, noDive), noDive), ["mcp", "board", "skills"], "past Agent Board, Deep Dive not offered here");
  assert.deepEqual(shownOf(placeAt(l, "review", "sessions")), ["review", "sessions", "agents", "needs", "automations"]);
  assert.deepEqual(shownOf(placeAt(l, "sessions", "needs")), ["agents", "needs", "sessions", "automations", "review"]);
  const off = setShown(l, "review", false);
  assert.ok(hiddenOf(off).includes("review"));
  assert.ok(shownOf(setShown(off, "review", true)).includes("review"));
  assert.equal(setShown(l, "sessions", false), l);
});
