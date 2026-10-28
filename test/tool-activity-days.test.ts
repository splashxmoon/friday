// The home screen's year in the person's own days (tool-usage.ts daily): turns are counted by UTC day with the hour each came
// in, and told back on the day it was where the person is (2026-10-27 QA: at 8:58 PM in New York a turn was "tomorrow").
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localKV } from "../src/local/kv.js";
import { dayInZone, ToolUsage } from "../src/tool-usage.js";

test("a day's turns land on the person's own day across midnight, UTC when no zone is said", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-days-"));
  const kv = await localKV(home);
  t.after(async () => (await kv.close(), await rm(home, { recursive: true, force: true })));
  const usage = new ToolUsage(kv.redis, "p:");
  // 00:58 UTC on the 28th is 8:58 PM on the 27th in New York, 6:28 AM on the 28th in Kolkata.
  const now = Date.UTC(2026, 9, 28, 0, 58);
  await kv.redis.hset("p:tooldays:ws:2026-10-28", "claude", "1", "h:0", "1");
  // 20:30 UTC on the 27th: 4:30 PM in New York, 2 AM on the 28th in Kolkata.
  await kv.redis.hset("p:tooldays:ws:2026-10-27", "codex", "3", "h:20", "2");

  const ny = await usage.daily("ws", 3, "America/New_York", now);
  assert.deepEqual(ny.map((d) => d.day), ["2026-10-25", "2026-10-26", "2026-10-27"], "ending on New York's today");
  // The one turn on the 27th counted before its hour was kept stays on its UTC day; the two with an hour are the 27th there too.
  assert.equal(ny.at(-1)!.turns, 4, "the evening's turn is the 27th's, not tomorrow's");

  const kolkata = await usage.daily("ws", 2, "Asia/Kolkata", now);
  assert.deepEqual(kolkata, [{ day: "2026-10-27", turns: 1 }, { day: "2026-10-28", turns: 3 }], "a half-hour zone: the hour's middle decides");

  assert.deepEqual(await usage.daily("ws", 2, undefined, now), [{ day: "2026-10-27", turns: 3 }, { day: "2026-10-28", turns: 1 }], "UTC days without a zone");
  assert.deepEqual(await usage.daily("ws", 2, "Not/AZone", now), await usage.daily("ws", 2, undefined, now), "and with one this computer doesn't know");
  assert.equal(dayInZone("America/Los_Angeles")(now), "2026-10-27");
});
