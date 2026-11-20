import assert from "node:assert/strict";
import { test } from "node:test";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { AWAKE_AHEAD_MS, cleanLater, countdown, describeAt, inAnHour, isAbsoluteFolder, isNightAt, laterDue, laterWantsAwake, LATE_GRACE_MS, offsetAt, pickedToUtc, tonightAt, utcToPicked, zonedToUtc, type LaterTask } from "../src/later.js";
import { LaterStore } from "../src/later-store.js";

const iso = (ms: number) => new Date(ms).toISOString();

test("zonedToUtc: a zone's wall clock becomes the UTC instant, daylight saving included", () => {
  assert.equal(iso(zonedToUtc(2026, 11, 21, 1, 0, "UTC")), "2026-11-21T01:00:00.000Z");
  // Los Angeles is UTC-8 in November, UTC-7 in July.
  assert.equal(iso(zonedToUtc(2026, 11, 21, 1, 0, "America/Los_Angeles")), "2026-11-21T09:00:00.000Z");
  assert.equal(iso(zonedToUtc(2026, 7, 21, 1, 0, "America/Los_Angeles")), "2026-07-21T08:00:00.000Z");
  // India has no daylight saving and a half-hour offset.
  assert.equal(iso(zonedToUtc(2026, 11, 21, 1, 0, "Asia/Kolkata")), "2026-11-20T19:30:00.000Z");
  assert.equal(offsetAt(Date.UTC(2026, 10, 21), "Asia/Kolkata"), 330);
});

test("zonedToUtc: the hour spring forward skips lands after the gap", () => {
  // 2026-03-08 02:30 does not exist in New York (clocks go 02:00 -> 03:00).
  const t = zonedToUtc(2026, 3, 8, 2, 30, "America/New_York");
  assert.equal(offsetAt(t, "America/New_York"), -240);
  assert.equal(iso(t), "2026-03-08T07:30:00.000Z");
});

test("tonightAt: the next 1:00 on the person's own clock", () => {
  // 8 pm in Los Angeles on the 20th: 1 AM on the 21st is five hours away.
  const eight = zonedToUtc(2026, 11, 20, 20, 0, "America/Los_Angeles");
  assert.equal(tonightAt(eight, "America/Los_Angeles"), zonedToUtc(2026, 11, 21, 1, 0, "America/Los_Angeles"));
  // 00:30 the same night: 1 AM is later today, thirty minutes away.
  const half = zonedToUtc(2026, 11, 21, 0, 30, "America/Los_Angeles");
  assert.equal(tonightAt(half, "America/Los_Angeles"), half + 30 * 60_000);
  // 03:00: tomorrow's 1 AM.
  const three = zonedToUtc(2026, 11, 21, 3, 0, "America/Los_Angeles");
  assert.equal(tonightAt(three, "America/Los_Angeles"), zonedToUtc(2026, 11, 22, 1, 0, "America/Los_Angeles"));
  // Under a minute before 1:00: not "now", the night after.
  const near = zonedToUtc(2026, 11, 21, 0, 59, "UTC") + 30_000;
  assert.equal(tonightAt(near, "UTC"), zonedToUtc(2026, 11, 22, 1, 0, "UTC"));
  // The same instant is a different night in another zone.
  const now = Date.UTC(2026, 10, 20, 22, 0);
  assert.notEqual(tonightAt(now, "Asia/Kolkata"), tonightAt(now, "America/Los_Angeles"));
  // 22:00 UTC is 03:30 on the 21st in India: its next 1 AM is the 22nd's, 19:30 UTC on the 21st.
  assert.equal(iso(tonightAt(now, "Asia/Kolkata")), "2026-11-21T19:30:00.000Z");
});

test("tonightAt: across the end of a month and a daylight-saving change", () => {
  const now = zonedToUtc(2026, 10, 31, 23, 0, "America/New_York");
  assert.equal(tonightAt(now, "America/New_York"), zonedToUtc(2026, 11, 1, 1, 0, "America/New_York"));
  // 1:00 on 2026-11-01 is the first of two 1:00s in New York (clocks fall back at 2:00): the first one.
  assert.equal(iso(tonightAt(now, "America/New_York")), "2026-11-01T05:00:00.000Z");
});

test("a picked time is read as the person's wall clock and shown back the same", () => {
  const at = pickedToUtc("2026-11-21T09:30", "Asia/Kolkata")!;
  assert.equal(iso(at), "2026-11-21T04:00:00.000Z");
  assert.equal(utcToPicked(at, "Asia/Kolkata"), "2026-11-21T09:30");
  assert.equal(utcToPicked(at, "America/Los_Angeles"), "2026-11-20T20:00");
  assert.equal(pickedToUtc("not a time", "UTC"), null);
  assert.equal(pickedToUtc("2026-13-01T00:00", "UTC"), null);
});

test("describeAt: tonight, today, tomorrow, a weekday; on the viewer's own clock", () => {
  const tz = "America/Los_Angeles";
  const now = zonedToUtc(2026, 11, 20, 20, 0, tz);
  assert.equal(describeAt(zonedToUtc(2026, 11, 21, 1, 0, tz), now, tz), "tonight at 1:00 AM");
  assert.equal(describeAt(zonedToUtc(2026, 11, 20, 23, 0, tz), now, tz), "tonight at 11:00 PM");
  assert.equal(describeAt(inAnHour(now), now, tz), "tonight at 9:00 PM");
  assert.equal(describeAt(zonedToUtc(2026, 11, 20, 15, 30, tz), zonedToUtc(2026, 11, 20, 9, 0, tz), tz), "today at 3:30 PM");
  assert.equal(describeAt(zonedToUtc(2026, 11, 21, 9, 0, tz), now, tz), "tomorrow at 9:00 AM");
  assert.match(describeAt(zonedToUtc(2026, 11, 24, 9, 0, tz), now, tz), /^Tue 9:00 AM$/);
  // The same instant read in India is a different day and hour.
  assert.equal(describeAt(zonedToUtc(2026, 11, 21, 1, 0, tz), now, "Asia/Kolkata"), "today at 2:30 PM");
});

test("laterDue: only a queued task, from its moment, until the grace passes", () => {
  const at = 1_000_000;
  assert.equal(laterDue({ status: "queued", at }, at - 1), null);
  assert.equal(laterDue({ status: "queued", at }, at), "run");
  assert.equal(laterDue({ status: "queued", at }, at + LATE_GRACE_MS), "run");
  // Friday was closed through its time: missed, never started hours late.
  assert.equal(laterDue({ status: "queued", at }, at + LATE_GRACE_MS + 1), "missed");
  for (const status of ["starting", "running", "missed", "failed"] as const) assert.equal(laterDue({ status, at }, at + 5), null);
});

test("cleanLater: a task as the page sent it, or why not", () => {
  const now = 1_700_000_000_000;
  const ok = cleanLater({ folder: "/work/app", ask: "  Fix the refund bug\nthen run tests ", tool: "claude", mode: "edits", at: now + 3600_000, model: "opus", fullAccess: true }, now);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.task.title, "Fix the refund bug");
    assert.equal(ok.task.ask, "Fix the refund bug\nthen run tests");
    assert.equal(ok.task.fullAccess, false, "full access only goes with Auto");
    assert.equal(ok.task.mode, "edits");
  }
  const bad = (x: Record<string, unknown>) => cleanLater({ folder: "/w", ask: "x", tool: "claude", at: now + 1000, ...x }, now);
  assert.equal(bad({ folder: "" }).ok, false);
  assert.equal(bad({ ask: "  " }).ok, false);
  assert.equal(bad({ tool: "friday" }).ok, false);
  assert.equal(bad({ at: now - 5 * 60_000 }).ok, false);
  assert.equal(bad({ at: now + 40 * 24 * 3600_000 }).ok, false);
  assert.equal(bad({ at: "soon" }).ok, false);
  assert.equal(bad({ at: now - 10_000 }).ok, true, "Run now sends the moment it was pressed");
  const full = bad({ mode: "full", fullAccess: true });
  assert.ok(full.ok && full.task.fullAccess);
  assert.equal(bad({ mode: "weird" }).ok && (bad({ mode: "weird" }) as { task: { mode: string } }).task.mode, "full");
});

test("describeAt: only the coming night is tonight", () => {
  const tz = "America/Los_Angeles";
  // 2 PM: tomorrow's 11 PM is a day away; tomorrow's 2 AM is the coming night.
  const afternoon = zonedToUtc(2026, 11, 20, 14, 0, tz);
  assert.equal(describeAt(zonedToUtc(2026, 11, 21, 23, 0, tz), afternoon, tz), "tomorrow at 11:00 PM");
  assert.equal(describeAt(zonedToUtc(2026, 11, 21, 2, 0, tz), afternoon, tz), "tonight at 2:00 AM");
  assert.equal(describeAt(zonedToUtc(2026, 11, 20, 23, 0, tz), afternoon, tz), "tonight at 11:00 PM");
  // 12:30 AM is already the night: 2 AM today is tonight, 2 AM tomorrow is over a day off.
  const past = zonedToUtc(2026, 11, 21, 0, 30, tz);
  assert.equal(describeAt(zonedToUtc(2026, 11, 21, 2, 0, tz), past, tz), "tonight at 2:00 AM");
  assert.equal(describeAt(zonedToUtc(2026, 11, 22, 2, 0, tz), past, tz), "tomorrow at 2:00 AM");
  // 11 PM: the small hours of the next date are this night.
  assert.equal(describeAt(zonedToUtc(2026, 11, 21, 2, 0, tz), zonedToUtc(2026, 11, 20, 23, 0, tz), tz), "tonight at 2:00 AM");
});

test("isNightAt: nine in the evening to five in the morning, on the person's clock", () => {
  const at = zonedToUtc(2026, 11, 21, 1, 0, "Asia/Kolkata");
  assert.equal(isNightAt(at, "Asia/Kolkata"), true);
  assert.equal(isNightAt(at, "America/Los_Angeles"), false, "the same instant is the afternoon before there");
  assert.equal(isNightAt(zonedToUtc(2026, 11, 21, 15, 0, "UTC"), "UTC"), false);
  assert.equal(isNightAt(zonedToUtc(2026, 11, 21, 21, 0, "UTC"), "UTC"), true);
  assert.equal(isNightAt(zonedToUtc(2026, 11, 21, 4, 59, "UTC"), "UTC"), true);
  assert.equal(isNightAt(zonedToUtc(2026, 11, 21, 5, 0, "UTC"), "UTC"), false);
});

test("countdown: how far off, in words", () => {
  assert.equal(countdown(1_000_000 + 30_000, 1_000_000), "in 1 min");
  assert.equal(countdown(1_000_000 + 40 * 60_000, 1_000_000), "in 40 min");
  assert.equal(countdown(1_000_000 + 5 * 3600_000, 1_000_000), "in 5 h");
  assert.equal(countdown(1_000_000 + 3 * 86_400_000, 1_000_000), "in 3 days");
});

test("laterWantsAwake: the computer is kept from idle sleep for a task due soon, or starting, and not otherwise", () => {
  const now = 10_000_000;
  assert.equal(laterWantsAwake([], now), false);
  assert.equal(laterWantsAwake([{ status: "queued", at: now + 3600_000 }], now), true, "due in an hour");
  assert.equal(laterWantsAwake([{ status: "queued", at: now + AWAKE_AHEAD_MS }], now), true);
  assert.equal(laterWantsAwake([{ status: "queued", at: now + AWAKE_AHEAD_MS + 60_000 }], now), false, "a day off: the computer may sleep until it is closer");
  assert.equal(laterWantsAwake([{ status: "starting", at: now - 5000 }], now), true);
  assert.equal(laterWantsAwake([{ status: "queued", at: now - 1000 }], now), true, "just due, not started yet");
  assert.equal(laterWantsAwake([{ status: "queued", at: now - LATE_GRACE_MS - 1 }], now), false, "past its grace it is only going to be missed");
  assert.equal(laterWantsAwake([{ status: "missed", at: now }, { status: "failed", at: now }, { status: "running", at: now }], now), false);
});

test("cleanLater: the account and effort picked, the issue, a folder written in full", () => {
  const now = 1_700_000_000_000;
  const base = { folder: "/w", ask: "x", tool: "claude", at: now + 1000 };
  const ok = cleanLater({ ...base, account: "work", effort: "high", issue: { url: "https://github.com/a/b/issues/12", title: "Fix it" }, title: "#12 Fix it" }, now);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.task.account, "work");
    assert.equal(ok.task.effort, "high");
    assert.equal(ok.task.issue?.number, 12);
    assert.equal(ok.task.title, "#12 Fix it");
  }
  const none = cleanLater({ ...base, account: "default", effort: "ultra" }, now);
  assert.ok(none.ok && !none.task.account && !none.task.effort, "the default account is none, and an effort the tool doesn't take is dropped");
  assert.equal(cleanLater({ ...base, account: "../etc" }, now).ok, false);
  for (const f of ["/Users/me/app", "C:\\work\\app", "D:/work", "\\\\nas\\share\\app"]) assert.equal(isAbsoluteFolder(f), true, f);
  for (const f of ["app", "./app", "~/app", "..\\app"]) assert.equal(isAbsoluteFolder(f), false, f);
  assert.equal(cleanLater({ ...base, folder: "app" }, now).ok, false);
});

const task = (over: Partial<LaterTask> = {}): LaterTask => ({ id: "aaaaaaaaaa", ownerId: "u", ownerName: "U", folder: "/w", ask: "x", title: "x", tool: "claude", mode: "full", fullAccess: false, model: "", at: 1000, created: 0, status: "queued", ...over });

test("LaterStore.claim: two claims of one task, started together, are won once", async () => {
  const store = new LaterStore(new RedisMock() as unknown as Redis, "t1:");
  await store.put(task());
  const wins = await Promise.all([store.claim("aaaaaaaaaa", 5000), store.claim("aaaaaaaaaa", 5000), store.claim("aaaaaaaaaa", 5000, ["queued", "missed"])]);
  assert.equal(wins.filter(Boolean).length, 1);
  assert.equal((await store.get("aaaaaaaaaa"))!.status, "starting");
  // Run now takes a missed or failed one, and not one that is running.
  await store.put(task({ status: "missed" }));
  assert.equal(await store.claim("aaaaaaaaaa", 6000), null, "the clock only takes a queued one");
  assert.ok(await store.claim("aaaaaaaaaa", 6000, ["queued", "missed", "failed"]));
  await store.put(task({ status: "running" }));
  assert.equal(await store.claim("aaaaaaaaaa", 7000, ["queued", "missed", "failed"]), null);
});

test("LaterStore.mutate and drop: a change is made from what is stored now, and a start can't be cancelled", async () => {
  const store = new LaterStore(new RedisMock() as unknown as Redis, "t2:");
  await store.put(task({ at: 1000 }));
  // The tick listed it as queued; before its write, Run now took it. The tick's "missed" must not land on "starting".
  const stale = (await store.list())[0]!;
  await store.claim(stale.id, 9_000_000, ["queued"]);
  const marked = await store.mutate(stale.id, (x) => (laterDue(x, 9_000_000) === "missed" ? { ...x, status: "missed" } : null));
  assert.equal(marked, null);
  assert.equal((await store.get(stale.id))!.status, "starting");
  assert.equal(await store.drop(stale.id), false, "starting: not cancelled");
  // A task cancelled between the list and the write is not brought back.
  await store.put(task({ id: "bbbbbbbbbb" }));
  assert.equal(await store.drop("bbbbbbbbbb"), true);
  assert.equal(await store.mutate("bbbbbbbbbb", (x) => ({ ...x, status: "failed" })), null);
  assert.equal(await store.get("bbbbbbbbbb"), null);
});
