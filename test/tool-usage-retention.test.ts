// How long tool usage is kept (tool-usage.ts): the detail a hundred days, a count of turns per day about a year.
import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { DAILY_KEEP_S, KEEP_S, ToolUsage } from "../src/tool-usage.js";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const day = (ago = 0) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);

test("the detail expires at 100 days; the daily counts are kept about a year and outlast it", async (t) => {
  const prefix = `mpatest:ret${Date.now().toString(36)}:`;
  const r = new Redis(REDIS);
  t.after(async () => {
    const keys = await r.keys(`${prefix}*`);
    if (keys.length) await r.del(...keys);
    await r.quit();
  });
  const usage = new ToolUsage(r, prefix);
  await usage.record("ws1", "claude", { input: 120, cached: 0, output: 40 });
  await usage.record("ws1", "codex", { input: 50, cached: 10, output: 5 });

  const detail = `${prefix}toolusage:ws1:${day()}`;
  const daily = `${prefix}tooldays:ws1:${day()}`;
  assert.equal(KEEP_S, 100 * 86_400);
  assert.ok(Math.abs((await r.ttl(detail)) - KEEP_S) < 60, "the detail lives a hundred days");
  assert.ok(Math.abs((await r.ttl(daily)) - DAILY_KEEP_S) < 60 && DAILY_KEEP_S >= 371 * 86_400, "the daily count lives past a year");

  // Nothing but counts in it: no tokens, no titles, nothing said. Each tool's, and the hour they came in (tool-usage.ts daily).
  const { [`h:${new Date().getUTCHours()}`]: hour, ...tools } = await r.hgetall(daily);
  assert.deepEqual(tools, { claude: "1", codex: "1" });
  assert.equal(hour, "2");

  // The detail gone, as it is after a hundred days: the day still counts on the home screen's year.
  await r.del(detail);
  assert.equal((await usage.daily("ws1", 3)).at(-1)!.turns, 2);
  assert.equal((await usage.history("ws1", 1))[0]!.tools.claude, undefined, "and the Usage page's detail is gone");

  // A day from before the counts were kept is read from its detail, while that is still there.
  await r.hset(`${prefix}toolusage:ws1:${day(5)}`, "claude:turns", "4", "claude:input", "900");
  const days = await usage.daily("ws1", 10);
  assert.equal(days.length, 10);
  assert.equal(days.find((d) => d.day === day(5))!.turns, 4);
  assert.equal(days.find((d) => d.day === day(6))!.turns, 0);

  // Detail written while it was kept 400 days is brought down to a hundred; the daily counts keep their year.
  const old = `${prefix}toolusage:ws1:${day(2)}`;
  await r.hset(old, "claude:turns", "1");
  await r.expire(old, 400 * 86_400);
  await r.lpush(`${prefix}carried:ws1`, "{}");
  await r.expire(`${prefix}carried:ws1`, 400 * 86_400);
  assert.equal(await usage.capDetail(), 2);
  assert.ok((await r.ttl(old)) <= KEEP_S && (await r.ttl(`${prefix}carried:ws1`)) <= KEEP_S);
  assert.ok((await r.ttl(daily)) > KEEP_S, "the daily count is left alone");
  assert.equal(await usage.capDetail(), 0, "and a second run has nothing to do");
});
