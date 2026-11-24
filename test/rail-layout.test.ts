// The rail's places (rail-layout.ts): one order, each on the rail or off it (no ⋯ since 2026-11-21). What was kept is made whole (the first
// version's lists and lines read too), Sessions is always shown, and the moves the panel and the right-click make.
import assert from "node:assert/strict";
import test from "node:test";
import { hiddenOf, moveInRail, normalizeRail, placeAt, RAIL_DEFAULT, setShown, shownOf } from "../src/client/rail-layout.js";

test("kept layouts are made whole; the first version's are read; Sessions is shown", () => {
  assert.deepEqual(normalizeRail(null), RAIL_DEFAULT);
  assert.deepEqual(normalizeRail("junk"), RAIL_DEFAULT);
  assert.deepEqual(shownOf(RAIL_DEFAULT), ["sessions", "agents", "automations", "review", "board", "customize", "deepdive"]);
  assert.deepEqual(hiddenOf(RAIL_DEFAULT), [], "nothing off the rail: there is no ⋯");
  // The first version: the rail's list with lines and a place since gone, then the ⋯'s.
  const old = normalizeRail({ rail: ["today", "review", "sessions", "sep", "automations"], more: ["agents", "board"] });
  assert.deepEqual(shownOf(old), ["review", "sessions", "automations", "board", "customize", "deepdive"], "never kept: each after the place before it by default");
  assert.ok(old.hidden.includes("agents") && !old.hidden.includes("board"), "the Agent Board, once behind the ⋯, back on the rail");
  assert.equal(old.order.length, 7, "every place once, none unknown");
  // Sessions can't be hidden; a place never kept goes where it goes by default.
  const kept = normalizeRail({ order: ["review", "sessions"], hidden: ["sessions", "review"] });
  assert.ok(!kept.hidden.includes("sessions"));
  assert.ok(kept.hidden.includes("review"));
  assert.ok(!kept.hidden.includes("board"), "the Agent Board, not kept, on the rail as by default");
  // Kept since the ⋯ went (v 2): switched off stays off.
  assert.ok(normalizeRail({ order: ["sessions", "board"], hidden: ["board"], v: 2 }).hidden.includes("board"));
  // MCP servers, Skills and Needs you kept from before Customize: gone, and Customize where it goes, on the rail.
  const before = normalizeRail({ order: ["sessions", "agents", "needs", "automations", "review", "board", "deepdive", "mcp", "skills"], hidden: ["board", "deepdive", "mcp", "skills"] });
  assert.deepEqual(shownOf(before), ["sessions", "agents", "automations", "review", "board", "customize", "deepdive"]);
  assert.deepEqual(hiddenOf(before), []);
});

test("moves: a step among its neighbours, a drag to another's place, shown or not", () => {
  const l = RAIL_DEFAULT;
  assert.deepEqual(shownOf(moveInRail(l, "agents", -1)).slice(0, 2), ["agents", "sessions"]);
  assert.equal(moveInRail(l, "sessions", -1), l, "nothing above the first");
  // A step skips what's off the rail, and what this window doesn't offer.
  const noDive = (p: string) => p !== "deepdive";
  assert.deepEqual(shownOf(moveInRail(l, "deepdive", 1)), shownOf(l), "the last on the rail stays last");
  const both = setShown(setShown(l, "board", false), "deepdive", false);
  assert.deepEqual(hiddenOf(moveInRail(both, "board", 1, noDive), noDive), ["board"], "Deep Dive not offered here: nothing to pass");
  assert.deepEqual(shownOf(placeAt(l, "review", "sessions")), ["review", "sessions", "agents", "automations", "board", "customize", "deepdive"]);
  assert.deepEqual(shownOf(placeAt(l, "sessions", "automations")), ["agents", "automations", "sessions", "review", "board", "customize", "deepdive"]);
  const off = setShown(l, "review", false);
  assert.ok(hiddenOf(off).includes("review"));
  assert.ok(shownOf(setShown(off, "review", true)).includes("review"));
  assert.equal(setShown(l, "sessions", false), l);
});
