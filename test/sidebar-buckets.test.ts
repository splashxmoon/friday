import assert from "node:assert/strict";
import test from "node:test";
import { buckets, SETTLE_AFTER_MS, snoozePresets, snoozeWord } from "../src/client/sidebar-buckets.js";
import type { RecentSession } from "../src/client/storage.js";

/** Arun, 2026-10-25: Snoozed and Settled sessions out of the list, back by themselves only when something in one needs you. */
const NOW = Date.UTC(2026, 9, 25, 15);
const r = (sid: string, over: Partial<RecentSession> = {}): RecentSession => ({ sid, title: sid, invite: "i", role: "owner", openedAt: NOW - 60_000, ...over });

test("a snoozed session sleeps until its time, a quiet one settles after three days, and needing you wakes either", () => {
  const list = [r("live"), r("nap", { snoozedUntil: NOW + 3_600_000 }), r("old", { openedAt: NOW - SETTLE_AFTER_MS - 1 }), r("done", { settledAt: NOW - 1000 }), r("over", { snoozedUntil: NOW - 1 })];
  const b = buckets(list, { needs: new Set(), working: new Set() }, NOW);
  assert.deepEqual(b.active.map((x) => x.sid), ["live", "over"], "a snooze that has run out is awake");
  assert.deepEqual(b.snoozed.map((x) => x.sid), ["nap"]);
  assert.deepEqual(b.settled.map((x) => x.sid), ["old", "done"]);
  const woken = buckets(list, { needs: new Set(["nap"]), working: new Set(["old"]) }, NOW);
  assert.deepEqual(woken.active.map((x) => x.sid), ["live", "nap", "old", "over"], "something waiting on you, or an agent at work, brings it back");
});

test("the snooze presets and how a sleeping row says how long", () => {
  const p = snoozePresets(NOW);
  assert.deepEqual(p.map((x) => x.label), ["For 3 hours", "Until tomorrow morning", "Until next week"]);
  assert.equal(p[0]!.until, NOW + 3 * 3_600_000);
  assert.equal(new Date(p[1]!.until).getHours(), 9);
  assert.match(snoozeWord(NOW + 2 * 3_600_000, NOW), /^for 2 more hours$/);
  assert.match(snoozeWord(p[1]!.until, NOW), /tomorrow$/);
  assert.equal(snoozeWord(NOW - 5, NOW), "waking");
});

test("a session whose pull request merged settles by itself, unless something in it is awake", () => {
  const list = [r("shipped"), r("open"), r("busy")];
  const b = buckets(list, { needs: new Set(), working: new Set(["busy"]), merged: new Set(["shipped", "busy"]) }, NOW);
  assert.deepEqual(b.settled.map((x) => x.sid), ["shipped"]);
  assert.deepEqual(b.active.map((x) => x.sid), ["open", "busy"]);
});
