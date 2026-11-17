// Routines (teammate-checkins.ts; Arun, 2026-11-15: "add routines too, make it very advanced ... combine the check ins with the
// routines"): every few hours, on and off, where each runs, quiet or not, and when it runs next.
import assert from "node:assert/strict";
import test from "node:test";
import { checkInDue, checkInText, cleanCheckIn, describeCheckIn, nextRun } from "../src/teammate-checkins.js";

test("a routine keeps its name, every few hours, off, a new thread each time and always saying, and nothing it can't", () => {
  const c = cleanCheckIn({ name: "  Weekly   review ", text: "Sum up the week.", every: "every", hours: 3, at: "09:00", days: [], tz: "UTC", off: true, where: "thread", quiet: false, extra: 1 }, "r1")!;
  assert.deepEqual(c, { id: "r1", name: "Weekly review", text: "Sum up the week.", every: "every", hours: 3, at: "09:00", days: [], tz: "UTC", off: true, where: "thread", quiet: false });
  assert.equal(cleanCheckIn({ text: "x", every: "every", hours: 5, at: "09:00", tz: "UTC" }, "r2")!.hours, 4, "an hours step it doesn't offer: four");
  assert.equal(cleanCheckIn({ text: "x", every: "daily", at: "09:00", tz: "UTC", where: "elsewhere", quiet: true }, "r3")!.where, undefined);
  assert.equal(describeCheckIn(c), "every 3 hours");
});

test("every few hours runs on the hours that divide by it, once a slot; off never runs", () => {
  const c = cleanCheckIn({ text: "Look around.", every: "every", hours: 4, at: "09:00", tz: "UTC" }, "r1")!;
  assert.equal(checkInDue(c, new Date("2026-11-16T08:05:00Z")), "2026-11-16T08");
  assert.equal(checkInDue(c, new Date("2026-11-16T09:05:00Z")), null);
  assert.equal(checkInDue(c, new Date("2026-11-16T08:30:00Z")), null, "only in its first quarter hour");
  assert.equal(checkInDue({ ...c, off: true }, new Date("2026-11-16T08:05:00Z")), null);
});

test("next run: the first minute it is due, not one already run, and none while off", () => {
  const c = cleanCheckIn({ text: "Stand-up.", every: "weekdays", at: "09:00", tz: "UTC" }, "r1")!;
  // A Saturday: Monday at nine.
  assert.equal(nextRun(c, new Date("2026-11-14T12:00:00Z"))?.toISOString(), "2026-11-16T09:00:00.000Z");
  // Run already in Monday's slot: Tuesday.
  assert.equal(nextRun({ ...c, last: "2026-11-16" }, new Date("2026-11-16T09:30:00Z"))?.toISOString(), "2026-11-17T09:00:00.000Z");
  assert.equal(nextRun({ ...c, off: true }), null);
});

test("what it is asked: quiet by default, and saying it always when set so", () => {
  const c = cleanCheckIn({ name: "Review", text: "Sum up.", every: "daily", at: "16:00", tz: "UTC" }, "r1")!;
  assert.match(checkInText(c), /^\[Check-in\] Sum up\./);
  assert.match(checkInText(c), /"Review"/);
  assert.match(checkInText(c), /NO_UPDATE/);
  assert.doesNotMatch(checkInText({ ...c, quiet: false }), /NO_UPDATE/);
});

test("a routine whose time came while the computer slept runs on waking; one turned on after its time does not", async () => {
  const { missedSlot, cleanCheckIn, checkInText } = await import("../src/teammate-checkins.js");
  const c = cleanCheckIn({ text: "Stand-up", every: "daily", at: "09:00", tz: "UTC" }, "s")!;
  assert.deepEqual(missedSlot(c, new Date("2026-11-16T07:00:00Z"), new Date("2026-11-16T13:12:00Z"))?.slot, "2026-11-16", "asleep from 7:00 to 13:12: the 9:00 is missed");
  assert.equal(missedSlot(c, new Date("2026-11-16T10:00:00Z"), new Date("2026-11-16T13:12:00Z")), null, "asleep only after it was due and done");
  assert.equal(missedSlot({ ...c, last: "2026-11-16" }, new Date("2026-11-16T07:00:00Z"), new Date("2026-11-16T13:12:00Z")), null, "already run for that day");
  assert.equal(missedSlot({ ...c, off: true }, new Date("2026-11-16T07:00:00Z"), new Date("2026-11-16T13:12:00Z")), null);
  assert.match(checkInText(c, { due: "09:00", now: "1:12 PM" }), /due at 09:00, while this computer was asleep; it runs now, at 1:12 PM/);
});
