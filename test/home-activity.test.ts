// The home screen's year of work (HomeActivity.tsx).
import assert from "node:assert/strict";
import test from "node:test";
import { heatmap, streaks } from "../src/client/HomeActivity.js";

test("a year, a week to a column, Sunday first, today last; busier days darker", () => {
  const today = new Date(2026, 9, 15); // a Thursday
  const day = (d: number) => ({ day: `2026-10-${String(d).padStart(2, "0")}`, turns: d === 15 ? 8 : 2 });
  const cols = heatmap([day(14), day(15)], today);
  assert.equal(cols.length, 52);
  assert.ok(cols.slice(0, -1).every((c) => c.length === 7), "full weeks before this one");
  assert.equal(cols.at(-1)!.length, 5, "this week runs Sunday to Thursday");
  assert.equal(cols.at(-1)!.at(-1)!.day, "2026-10-15");
  assert.equal(cols.at(-1)!.at(-1)!.level, 4, "the busiest day is the darkest");
  assert.equal(cols.at(-1)!.at(-2)!.level, 1, "a quarter of it is the lightest shade");
});

test("streaks: the longest, and the one still going", () => {
  const t = (n: number) => ({ turns: n });
  assert.deepEqual(streaks([t(1), t(1), t(0), t(3), t(1), t(1)]), { longest: 3, current: 3 });
  assert.deepEqual(streaks([t(1), t(0)]), { longest: 1, current: 0 });
});

test("the year is the grid's days: one sent from past its end neither shows the year nor shades it (2026-10-27 QA)", () => {
  const today = new Date(2026, 9, 27);
  const cols = heatmap([{ day: "2026-10-28", turns: 9 }, { day: "2026-10-27", turns: 1 }], today);
  const flat = cols.flat();
  assert.equal(flat.reduce((n, c) => n + c.turns, 0), 1, "tomorrow isn't in it");
  assert.equal(flat.at(-1)!.level, 4, "today, the grid's busiest, is darkest");
  assert.equal(heatmap([{ day: "2026-10-28", turns: 9 }], today).flat().reduce((n, c) => n + c.turns, 0), 0, "nothing to show");
});
