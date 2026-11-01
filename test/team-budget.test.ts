// Crew budgets and work hours (team-budget.ts): a teammate's daily cap and hours, held between turns and carried on the next
// window or day, and a room running on its own stopped by its budget or end time (Arun, 2026-10-31: the top Crew feature, so
// Run on its own and Away mode are safe to leave running overnight).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { cleanBudget, cleanRunBudget, dayStart, DEFAULT_RUN_TOKENS, holdLine, holdOf, nextDayStart, priceOf, runOver, type MateBudget } from "../src/team-budget.js";
import { type TeammateView } from "../src/teammates.js";
import { type SessionEvent } from "../src/types.js";

process.env.FRIDAY_MINE = "1";
process.env.FRIDAY_TEAMMATES_DRY = "1";

const NY = "America/New_York";
/** A time in New York on 2026-11-02 (a Monday, after the clocks went back): "HH:MM". */
const ny = (hhmm: string, day = "2026-11-02") => Date.parse(`${day}T${hhmm}:00-05:00`);
const none = { input: 0, output: 0 };

// ── The rules ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("quiet hours past midnight hold it, and say when it carries on in its keeper's zone", () => {
  const b: MateBudget = { tz: NY, quiet: { from: "23:00", to: "07:00" } };
  assert.equal(holdOf(b, ny("22:59"), none, null), null);
  const late = holdOf(b, ny("23:30"), none, null);
  assert.deepEqual(late, { why: "quiet", until: ny("07:00", "2026-11-03") });
  assert.deepEqual(holdOf(b, ny("03:00"), none, null), { why: "quiet", until: ny("07:00") });
  assert.equal(holdOf(b, ny("07:00"), none, null), null);
  assert.equal(holdLine(late!, (ts) => new Date(ts).toLocaleTimeString("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" })), "Paused till 7:00 AM · quiet hours");
  // Someone in London reading the same teammate sees their own clock, the same moment.
  assert.equal(new Date(late!.until!).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }), "12:00");
});

test("work hours: weekdays nine to six, and a night window belongs to the day it starts", () => {
  const b: MateBudget = { tz: NY, hours: { from: "09:00", to: "18:00", days: [1, 2, 3, 4, 5] } };
  assert.equal(holdOf(b, ny("10:00"), none, null), null, "Monday at ten");
  assert.deepEqual(holdOf(b, ny("18:30"), none, null), { why: "hours", until: ny("09:00", "2026-11-03") });
  // Friday evening waits for Monday morning.
  assert.deepEqual(holdOf(b, ny("19:00", "2026-11-06"), none, null), { why: "hours", until: ny("09:00", "2026-11-09") });
  const night: MateBudget = { tz: NY, hours: { from: "22:00", to: "06:00", days: [1] } };
  assert.equal(holdOf(night, ny("02:00", "2026-11-03"), none, null), null, "Tuesday 2 AM is Monday night's");
  assert.equal(holdOf(night, ny("02:00"), none, null)?.why, "hours", "Monday 2 AM is Sunday night's");
  // No day picked would never open: refused when it is set.
  assert.throws(() => cleanBudget({ tz: NY, hours: { from: "09:00", to: "18:00", days: [] } }), /at least one day/);
  assert.throws(() => cleanBudget({ tz: NY, quiet: { from: "09:00", to: "09:00" } }), /same time/);
  assert.equal(cleanBudget({ tz: NY }), null, "nothing set is no budget");
  assert.equal(cleanBudget({ tz: "Nowhere/Else", tokens: 5 })!.tz, "UTC");
});

test("a daily cap holds it until its keeper's next midnight, and the day after it carries on", () => {
  const b: MateBudget = { tz: NY, tokens: 200_000 };
  const at = ny("15:00");
  assert.equal(holdOf(b, at, { input: 150_000, output: 49_999 }, null), null);
  const h = holdOf(b, at, { input: 150_000, output: 50_000 }, null)!;
  assert.deepEqual(h, { why: "tokens", until: ny("00:00", "2026-11-03"), spent: 200_000, cap: 200_000 });
  assert.equal(holdLine(h, () => "12:00 AM"), "Daily budget reached · back at 12:00 AM");
  // Tomorrow's day starts from nothing spent.
  assert.equal(dayStart(NY, ny("00:05", "2026-11-03")), ny("00:00", "2026-11-03"));
  // A day the clocks change is still one day: 2026-11-01 in New York has 25 hours.
  assert.equal(nextDayStart(NY, Date.parse("2026-11-01T12:00:00-05:00")), ny("00:00"));
  assert.equal(dayStart(NY, Date.parse("2026-11-01T12:00:00-05:00")), Date.parse("2026-11-01T00:00:00-04:00"), "its midnight was still on summer time");
  assert.equal(nextDayStart(NY, Date.parse("2026-10-31T15:00:00-04:00")), Date.parse("2026-11-01T00:00:00-04:00"));
  assert.equal(dayStart(NY, Date.parse("2026-03-08T12:00:00-04:00")), Date.parse("2026-03-08T00:00:00-05:00"), "and the spring one");
  // With quiet hours past the next midnight, it carries on when they end, not at midnight.
  assert.equal(holdOf({ ...b, quiet: { from: "23:00", to: "07:00" } }, at, { input: 300_000, output: 0 }, null)!.until, ny("07:00", "2026-11-03"));
});

test("dollars only where its model's price is known; a plan cap from its tool's windows", () => {
  assert.deepEqual(priceOf({ tool: "claude", model: "opus" }), [4, 20]);
  assert.equal(priceOf({ tool: "claude", model: "auto" }), null, "smart routing has no one price");
  assert.equal(priceOf({ tool: "codex", model: "gpt-6.1-sol" }), null);
  const b: MateBudget = { tz: NY, usd: 5 };
  // 1M in at $4 + 50k out at $20 = $5.
  assert.equal(holdOf(b, ny("12:00"), { input: 1_000_000, output: 50_000 }, [4, 20])?.why, "usd");
  assert.equal(holdOf(b, ny("12:00"), { input: 9_000_000, output: 0 }, null), null, "no price, no dollar cap");
  const plan: MateBudget = { tz: NY, planPct: 80 };
  const reset = Math.round(ny("14:20") / 1000);
  assert.equal(holdOf(plan, ny("12:00"), none, null, [{ kind: "five_hour", usedPercent: 79, resetsAt: reset }]), null);
  const p = holdOf(plan, ny("12:00"), none, null, [{ kind: "five_hour", usedPercent: 85, resetsAt: reset }, { kind: "week", usedPercent: 40, resetsAt: reset + 86_400 }])!;
  assert.deepEqual(p, { why: "plan", until: reset * 1000, spent: 85, cap: 80 });
  assert.equal(holdLine(p, () => "2:20 PM"), "At 85% of its plan's window · back at 2:20 PM");
});

test("a run's budget: 5M tokens unless said, none when set to 0, and an end time", () => {
  const now = Date.now();
  assert.equal(cleanRunBudget(undefined, now).tokens, DEFAULT_RUN_TOKENS);
  assert.equal(cleanRunBudget({ tokens: 0 }, now).tokens, undefined);
  assert.throws(() => cleanRunBudget({ until: now - 1 }, now), /end time/);
  const ev = (seq: number, lane: string, input: number, output: number): SessionEvent => ({ seq, ts: now + seq, actor: { id: "e", name: "e", kind: "agent" }, lane, body: { type: "agent.usage", input, cached: 1_000, output } }) as SessionEvent;
  const events = [ev(1, "a", 400, 100), ev(2, "b", 300, 0), ev(3, "c", 10_000, 0)];
  // Cache reads count at a tenth (100 a turn here); another room's lane isn't counted.
  assert.equal(runOver({ since: now, budget: { tokens: 1001 } }, events, ["a", "b"], now), null);
  assert.match(runOver({ since: now, budget: { tokens: 1000 } }, events, ["a", "b"], now) ?? "", /budget is spent: 1,?000 of 1,?000 tokens|budget is spent: 1K of 1K tokens|budget is spent: 1k of 1k tokens/);
  assert.match(runOver({ since: now, budget: { until: now + 1000, tz: NY } }, [], ["a"], now + 1000) ?? "", /end time came/);
  assert.equal(runOver({ since: now }, events, ["a", "b", "c"], now), null, "a run from before budgets runs on");
});

// ── The open-source edition ─────────────────────────────────────────────────────────────────────────────────────────────────

const me = { id: "local", name: "Me", kind: "human" } as const;
type Team = { sid: string; teammates: TeammateView[]; selfRuns?: Record<string, { goal: string; budget?: { tokens?: number; until?: number } }>; error?: string };

async function crew(t: TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "friday-team-budget-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const send = async <T = Team>(url: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${app.url}${url}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as T };
  };
  let team: Team | null = null;
  for (const name of ["Nova", "Kit"]) team = (await send("/api/teammates", "POST", { name, tool: "claude", model: "sonnet", folder: path.join(home, name) })).body;
  const sid = team!.sid;
  const by = Object.fromEntries(team!.teammates.map((m) => [m.name, m])) as Record<string, TeammateView>;
  for (const m of team!.teammates) await app.store.append(sid, me, { type: "engine.attached", engine: { tool: "claude", cwd: home, hostId: "local", hostName: "Me", mode: "full" } }, { lane: m.lane });
  const spend = (lane: string, input: number, output = 0) => app.store.append(sid, { id: "engine:local", name: "Me's Claude Code", kind: "agent" }, { type: "agent.usage", tool: "claude", input, cached: 0, output }, { lane });
  const said = async () => (await app.store.events(sid)).filter((e) => e.body.type === "team.budget");
  const mate = async (name: string) => (await send("/api/teammates")).body.teammates.find((m) => m.name === name)!;
  return { app, sid, by, send, spend, said, mate };
}

test("open-source edition: a teammate past its daily cap waits, says why once, lets the person through, and carries on when its budget allows", async (t) => {
  const { app, sid, by, send, spend, said, mate } = await crew(t);
  const nova = by.Nova!;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal((await send(`/api/teammates/${nova.id}`, "PATCH", { budget: { tz, tokens: 1_000 } })).status, 200);
  assert.equal((await mate("Nova")).budget?.tokens, 1_000);
  // Read fresh and written: the cache reads beside them don't count.
  await spend(nova.lane, 700, 300);
  assert.equal(await app.hub.teamPaused!(sid, nova.lane, [], false), true, "Friday's and the agents' messages wait");
  assert.equal(await app.hub.teamPaused!(sid, nova.lane, [], true), true, "and a run ends after the turn it is on");
  assert.equal(await app.hub.teamPaused!(sid, nova.lane, ["local"], false), false, "the person's own message goes through");
  const lines = await said();
  assert.equal(lines.length, 1, "said once");
  assert.ok(lines[0]!.body.type === "team.budget" && /Nova stops for now: its daily budget of 1k tokens is spent \(1k today\)\. What's queued for it is kept\. It carries on at/.test(lines[0]!.body.text));
  assert.ok(lines[0]!.body.type === "team.budget" && lines[0]!.body.lane === nova.lane, "in the room, naming its lane");
  // Its status line: why, and when it carries on (its keeper's next midnight).
  const v = await mate("Nova");
  assert.equal(v.hold?.why, "tokens");
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  assert.equal(v.hold?.until, midnight.getTime());
  assert.equal((await mate("Kit")).hold, undefined, "Kit has no budget");
  assert.equal(await app.hub.teamPaused!(sid, by.Kit!.lane, [], false), false);
  // The brief records it.
  const brief = (await send<{ stops?: { name: string; text: string }[] }>(`/api/teammates/since?ts=${Date.now() - 60_000}`)).body;
  assert.equal(brief.stops?.[0]?.name, "Nova");
  // A bigger budget lets it go on.
  await send(`/api/teammates/${nova.id}`, "PATCH", { budget: { tz, tokens: 50_000 } });
  assert.equal(await app.hub.teamPaused!(sid, nova.lane, [], false), false);
  assert.equal((await mate("Nova")).hold, undefined);
  // Cleared, it has none; an edit that doesn't name it keeps it.
  await send(`/api/teammates/${nova.id}`, "PATCH", { role: "Writes the docs." });
  assert.equal((await mate("Nova")).budget?.tokens, 50_000);
  await send(`/api/teammates/${nova.id}`, "PATCH", { budget: null });
  assert.equal((await mate("Nova")).budget, undefined);
  assert.equal((await send(`/api/teammates/${nova.id}`, "PATCH", { budget: { tz, hours: { from: "09:00", to: "18:00", days: [] } } })).status, 400);
});

test("open-source edition: quiet hours hold it while the team is away, said once, and nothing is held outside them", async (t) => {
  const { app, sid, by, send, said, mate } = await crew(t);
  const kit = by.Kit!;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const from = new Date(now.getTime() - 60 * 60_000);
  const to = new Date(now.getTime() + 60 * 60_000);
  await send("/api/teammates/away", "POST", { until: Date.now() + 8 * 3_600_000 });
  await send(`/api/teammates/${kit.id}`, "PATCH", { budget: { tz, quiet: { from: hhmm(from), to: hhmm(to) } } });
  assert.equal(await app.hub.teamPaused!(sid, kit.lane, [], false), true);
  assert.equal(await app.hub.teamPaused!(sid, kit.lane, [], false), true);
  assert.equal((await said()).length, 1);
  const v = await mate("Kit");
  assert.equal(v.hold?.why, "quiet");
  assert.equal(new Date(v.hold!.until!).getMinutes(), to.getMinutes());
  // Quiet hours that ended a minute ago hold nothing.
  const past = new Date(now.getTime() - 2 * 60_000);
  await send(`/api/teammates/${kit.id}`, "PATCH", { budget: { tz, quiet: { from: hhmm(from), to: hhmm(past) } } });
  assert.equal(await app.hub.teamPaused!(sid, kit.lane, [], false), false);
});

test("open-source edition: a room running on its own gets the overnight budget, and stops when it is spent or its end time comes", async (t) => {
  const { app, sid, by, send, spend } = await crew(t);
  const on = await send("/api/teammates/selfrun", "POST", { sid, goal: "Ship the refunds page" });
  assert.equal(on.body.selfRuns?.[sid]?.budget?.tokens, DEFAULT_RUN_TOKENS, "the default overnight budget");
  await send("/api/teammates/selfrun", "POST", { sid, on: false });
  assert.equal((await send("/api/teammates/selfrun", "POST", { sid, goal: "x", budget: { until: Date.now() - 5 } })).status, 400);
  await send("/api/teammates/selfrun", "POST", { sid, goal: "Ship the refunds page", budget: { tokens: 2_000 } });
  await spend(by.Nova!.lane, 1_000);
  await app.teammates.away(Date.now());
  assert.ok((await send("/api/teammates")).body.selfRuns?.[sid], "under its budget, it runs on");
  await spend(by.Kit!.lane, 600, 400);
  await app.teammates.away(Date.now());
  assert.equal((await send("/api/teammates")).body.selfRuns?.[sid], undefined, "spent, so stopped");
  const off = (await app.store.events(sid)).findLast((e) => e.body.type === "team.selfrun" && !e.body.on);
  assert.ok(off?.body.type === "team.selfrun" && off.body.budget && /budget is spent: 2k of 2k tokens/.test(off.body.why ?? ""), "said why");
  assert.equal(off?.actor.kind, "system");
  // An end time.
  await send("/api/teammates/selfrun", "POST", { sid, goal: "Tidy the docs", budget: { tokens: 0, until: Date.now() + 60_000 } });
  await app.teammates.away(Date.now());
  assert.ok((await send("/api/teammates")).body.selfRuns?.[sid]);
  await app.teammates.away(Date.now() + 61_000);
  assert.equal((await send("/api/teammates")).body.selfRuns?.[sid], undefined);
  const ended = (await app.store.events(sid)).findLast((e) => e.body.type === "team.selfrun" && !e.body.on);
  assert.match(ended?.body.type === "team.selfrun" ? (ended.body.why ?? "") : "", /end time came/);
  // The brief records the stop.
  const brief = (await send<{ stops?: { name: string; text: string }[] }>(`/api/teammates/since?ts=${Date.now() - 60_000}`)).body;
  assert.ok(brief.stops?.some((s) => s.name === "Run on its own" && /budget is spent/.test(s.text)));
});
