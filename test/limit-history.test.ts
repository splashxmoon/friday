// The Usage hub's reading of the coding tools' limits over time (limitHistory.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { crossedEighty, cyclesOf, forecastOf, listPrice, mostRoom, rightSize, windowsOf, withReading, type Win } from "../src/client/limitHistory.js";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const inH = (h: number) => Math.round((NOW + h * 3600_000) / 1000);
const five = (used: number, resetIn = 2): Win => ({ tool: "claude", key: "five_hour", label: "5h", minutes: 300, used, resetsAt: inH(resetIn) });

test("every tool's windows in one shape, a passed reset counted as started over", () => {
  const ws = windowsOf({
    claude: null,
    claudeWindows: [
      { status: null, kind: "five_hour", utilization: 0.4, resetsAt: inH(2), at: NOW },
      { status: null, kind: "seven_day", utilization: 0.7, resetsAt: inH(-1), at: NOW },
    ],
    codex: null,
    codexWindows: [{ kind: "primary", windowMinutes: 300, usedPercent: 12, resetsAt: inH(3), at: NOW }],
  } as never, NOW);
  assert.deepEqual(ws.map((w) => [w.tool, w.label, Math.round(w.used)]), [["claude", "5h", 40], ["claude", "Weekly", 0], ["codex", "5h", 12]]);
});

test("the pace of a five-hour window over its last hour, and when it would run out", () => {
  const w = five(50, 2);
  const samples = [
    { at: NOW - 60 * 60_000, used: 30, resetsAt: w.resetsAt },
    { at: NOW - 30 * 60_000, used: 40, resetsAt: w.resetsAt },
    { at: NOW, used: 50, resetsAt: w.resetsAt },
  ];
  const f = forecastOf(w, samples, NOW)!;
  assert.equal(Math.round(f.perHour), 20, "20 points an hour");
  assert.equal(f.atReset, 90, "ends the window at 90%");
  assert.equal(f.fullAt, null, "and doesn't run out before it resets");
  const fast = forecastOf(five(70, 2), [{ at: NOW - 30 * 60_000, used: 50, resetsAt: w.resetsAt }, { at: NOW, used: 70, resetsAt: w.resetsAt }], NOW)!;
  assert.equal(fast.atReset, 100);
  assert.equal(fast.fullAt, NOW + 45 * 60_000, "40 points an hour from 70% runs out in 45 minutes");
  assert.equal(forecastOf(w, [{ at: NOW - 5 * 60_000, used: 48, resetsAt: w.resetsAt }, { at: NOW, used: 50, resetsAt: w.resetsAt }], NOW), null, "not from five minutes of readings");
  assert.equal(forecastOf(w, [{ at: NOW - 60 * 60_000, used: 10, resetsAt: inH(-3) }, { at: NOW, used: 50, resetsAt: w.resetsAt }], NOW), null, "not across a reset");
});

test("readings: a week kept, near-duplicates folded, cycles' peaks", () => {
  let h = withReading({}, [five(10)], NOW - 8 * 24 * 3600_000);
  h = withReading(h, [five(20)], NOW);
  h = withReading(h, [five(25)], NOW + 30_000);
  assert.deepEqual(h["claude:five_hour"]!.map((s) => s.used), [25], "the week-old reading dropped, and one a minute apart replaced");
  assert.deepEqual(cyclesOf([{ at: 1, used: 30, resetsAt: 100 }, { at: 2, used: 80, resetsAt: 100 }, { at: 3, used: 10, resetsAt: 200 }]), [{ resetsAt: 100, peak: 80 }, { resetsAt: 200, peak: 10 }]);
});

test("the most room, prices, right-sizing and the 80% alert", () => {
  const codex: Win = { tool: "codex", key: "primary", label: "5h", minutes: 300, used: 8, resetsAt: inH(3) };
  const codexWeek: Win = { tool: "codex", key: "secondary", label: "Weekly", minutes: 10_080, used: 95, resetsAt: inH(30) };
  assert.deepEqual(mostRoom([five(60), codex]), { tool: "codex", left: 92 });
  assert.deepEqual(mostRoom([five(60), codex, codexWeek]), { tool: "claude", left: 40 }, "not a tool whose week is nearly spent");
  assert.equal(mostRoom([five(60)]), null, "nothing to compare with one tool");

  assert.deepEqual(listPrice("claude", "Max"), { usd: 100, tier: "Max" });
  assert.deepEqual(listPrice("codex", "Plus"), { usd: 20, tier: "Plus" });
  assert.equal(listPrice("cursor", "Something new"), null);

  const week = (used: number, resetInH: number): Win => ({ tool: "claude", key: "seven_day", label: "Weekly", minutes: 10_080, used, resetsAt: inH(resetInH) });
  assert.deepEqual(rightSize("claude", 100, week(15, 84), NOW), { usd: 20, tier: "Pro", pace: 30 }, "half the week gone at 15%: on pace for 30%");
  assert.equal(rightSize("claude", 100, week(5, 160), NOW), null, "too early in the week to say");
  assert.equal(rightSize("claude", 100, week(40, 84), NOW), null, "on pace for 80%: the plan fits");

  const before = withReading({}, [five(70)], NOW - 120_000);
  assert.equal(crossedEighty(before, [five(83)]).length, 1, "70 then 83: said once");
  assert.equal(crossedEighty(withReading(before, [five(83)], NOW), [five(88)]).length, 0, "and not again in the same window");
});
