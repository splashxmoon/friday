import { test } from "node:test";
import assert from "node:assert/strict";
import { byDay } from "../src/client/sidebar-days.js";

test("Recent is told by day: each day said once over its first session, newest first", () => {
  const now = new Date(2026, 9, 27, 15, 0).getTime();
  const h = 3_600_000;
  const rows = [{ openedAt: now - h }, { openedAt: now - 2 * h }, { openedAt: now - 20 * h }, { openedAt: now - 4 * 24 * h }, { openedAt: now - 30 * 24 * h }];
  assert.deepEqual(byDay(rows, now), ["Today", rows[0], rows[1], "Yesterday", rows[2], "This week", rows[3], "Earlier", rows[4]]);
});

test("a list all from one day, or with what needs you pulled to the top, goes unlabelled", () => {
  const now = new Date(2026, 9, 27, 15, 0).getTime();
  const one = [{ openedAt: now - 1000 }, { openedAt: now - 2000 }];
  assert.deepEqual(byDay(one, now), one);
  const pulled = [{ openedAt: now - 9 * 86_400_000 }, { openedAt: now - 1000 }];
  assert.deepEqual(byDay(pulled, now), pulled);
});

import { clipAbout } from "../src/client/work-outputs.js";

test("a collection's summary cut short ends at a word, with an ellipsis", () => {
  const long = "Selected exploration directions for the launch film, ".repeat(6);
  const c = clipAbout(long.slice(0, 240));
  assert.ok(c.endsWith("…"));
  const kept = c.slice(0, -1);
  assert.ok(long.startsWith(kept), "a prefix of the summary");
  assert.match(long.slice(kept.length, kept.length + 1), /[\s,.]/, "ending where a word ends");
  assert.equal(clipAbout("Short and whole."), "Short and whole.");
});
