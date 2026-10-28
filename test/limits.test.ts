import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { codexFromSnapshot, copilotFrom, cursorFrom, noteClaudeEvent, readLimits } from "../src/runner/limits.js";

test("Copilot's allowances, as its account endpoint lists them: only the ones its plan limits, with the month's reset", () => {
  const got = copilotFrom({
    access_type_sku: "free_limited_copilot",
    quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
    quota_snapshots: {
      chat: { entitlement: 200, percent_remaining: 99.25, unlimited: false },
      completions: { entitlement: 2000, percent_remaining: 100, unlimited: false },
      premium_interactions: { entitlement: 0, percent_remaining: 0, unlimited: false },
    },
  });
  assert.equal(got.plan, "Free");
  assert.deepEqual(got.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]), [["Chat", 0.75, 1793491200], ["Completions", 0, 1793491200]]);
  assert.equal(copilotFrom({ access_type_sku: "copilot_pro_plus", quota_snapshots: { premium_interactions: { entitlement: 1500, unlimited: true } } }).plan, "Pro Plus");
  assert.deepEqual(copilotFrom(null), { windows: [], plan: null });
});

test("Codex's limits are read from its own session log, newest line first", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "limits-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // No real sign-in is read, on any platform: neither Claude Code's usage endpoint, Codex's app server nor Cursor is asked from a test.
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.FRIDAY_CODEX_BIN = path.join(home, "no-codex");
  // Nor is Claude Code asked for its usage (claude-usage.test.ts asks a stand-in).
  process.env.FRIDAY_CLAUDE_BIN = path.join(home, "no-claude");
  process.env.APPDATA = home;
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.CODEX_HOME;
  const dir = path.join(home, ".codex", "sessions", "2026", "10", "01");
  await mkdir(dir, { recursive: true });
  const ev = (pct: number) =>
    JSON.stringify({ timestamp: "2026-10-01T10:00:00Z", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: pct, window_minutes: 300, resets_at: 1793420076 }, secondary: { used_percent: 11, window_minutes: 10080, resets_at: 1793900000 }, plan_type: "plus" } } });
  const premium = JSON.stringify({ payload: { type: "token_count", rate_limits: { limit_id: "premium", primary: null, secondary: null } } });
  await writeFile(path.join(dir, "rollout-a.jsonl"), [ev(10), "not json", ev(42), premium, '{"half":'].join("\n"));
  await utimes(path.join(dir, "rollout-a.jsonl"), new Date("2026-10-01T10:00:00Z"), new Date("2026-10-01T10:00:00Z"));
  // Newer, but imported from another tool: its limits say nothing, and it must not hide the real reading under it.
  await writeFile(path.join(dir, "rollout-imported.jsonl"), JSON.stringify({ timestamp: "2026-10-02T10:00:00Z", payload: { type: "token_count", rate_limits: null } }));
  const l = await readLimits();
  assert.equal(l.codexFrom, "log");
  assert.equal(l.codex?.usedPercent, 42, "the last complete line wins; another bucket and a half-written line are skipped");
  assert.equal(l.codex?.windowMinutes, 300);
  assert.equal(l.codex?.plan, "Plus");
  assert.deepEqual(l.codexWindows?.map((w) => [w.windowMinutes, w.usedPercent, w.resetsAt]), [[300, 42, 1793420076], [10080, 11, 1793900000]], "the five hours and the week");
  assert.equal(l.cursor, null, "no Cursor sign-in here");
  assert.equal(l.claude, null, "nothing seen from Claude Code yet");
});

test("a rate-limit event from Claude Code is kept, in seconds whichever unit it came in", async () => {
  noteClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.8, resetsAt: 1793420076000 } });
  await new Promise((r) => setTimeout(r, 100));
  const l = await readLimits();
  assert.equal(l.claude?.kind, "five_hour");
  assert.equal(l.claude?.utilization, 0.8);
  assert.equal(l.claude?.resetsAt, 1793420076);
  noteClaudeEvent({ type: "assistant" });
});

test("the session and the week are kept side by side, and a later event cannot erase what an earlier one said", async () => {
  noteClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.55, resetsAt: 1793900000 } });
  noteClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1793420076 } });
  await new Promise((r) => setTimeout(r, 200));
  // Same window, same reset, no figure this time: the earlier figure stands.
  noteClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", resetsAt: 1793900000 } });
  await new Promise((r) => setTimeout(r, 200));
  const l = await readLimits();
  assert.deepEqual(l.claudeWindows.map((w) => w.kind), ["five_hour", "seven_day"], "the session first, then the week");
  assert.equal(l.claudeWindows.find((w) => w.kind === "seven_day")?.utilization, 0.55);
  assert.equal(l.claudeWindows.find((w) => w.kind === "five_hour")?.utilization, 0.8, "the earlier five-hour figure is still there, with the same reset");
});

test("Claude Code's sign-in is never read: its limits are what it says as it runs, each account's apart", async () => {
  // Anthropic's terms: developers may not "collect, store, or intermediate Claude.ai credentials or session tokens" (Arun,
  // 2026-10-27: "i do not want my account banned"). Nothing here reads Claude Code's keychain item or its credentials file, or
  // calls its usage page.
  const src = await readFile(new URL("../src/runner/limits.ts", import.meta.url), "utf8");
  for (const banned of ["oauth/usage", "Claude Code-credentials", ".credentials.json", "claudeAiOauth"]) assert.ok(!src.includes(banned), `no ${banned}`);
  const before = await readLimits();
  assert.equal(before.claudePlan, null, "no plan read from a sign-in");
  // What a run as the Work account said is Work's, not the tool's own sign-in's.
  noteClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.33, resetsAt: 1793420076 } }, "work");
  await new Promise((r) => setTimeout(r, 200));
  const l = await readLimits();
  assert.notEqual(l.claudeWindows.find((w) => w.kind === "five_hour")?.utilization, 0.33);
  assert.equal(l.claudeFrom, "runs");
});

test("Codex's app server answers in camelCase, an older log in seconds from when it wrote it, and the free plan has one window", () => {
  const live = codexFromSnapshot({ primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1793420076 }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1793900000 }, planType: "pro" }, 1);
  assert.deepEqual(live?.windows.map((w) => [w.kind, w.label, w.usedPercent]), [["primary", "5-hour", 25], ["secondary", "Weekly", 60]]);
  assert.equal(live?.plan, "Pro");
  const old = codexFromSnapshot({ primary: { used_percent: 5, window_minutes: 43200, resets_in_seconds: 60 } }, 1, 1_800_000_000_000);
  assert.deepEqual(old?.windows.map((w) => [w.label, w.resetsAt]), [["Monthly", 1_800_000_060]]);
  assert.equal(codexFromSnapshot({ primary: null, secondary: null }), null, "nothing to say is nothing, not 0%");
});

test("Cursor's usage is its own models and the others apart, until the cycle ends; weekly plans reset on their own date", () => {
  const usage = { billingCycleEnd: "1793900000000", planUsage: { autoPercentUsed: 12.5, apiPercentUsed: 80, includedSpend: 900, limit: 2000 } };
  const monthly = cursorFrom(usage, { planInfo: { planName: "Pro" } }, 1);
  assert.equal(monthly.plan, "Pro");
  assert.deepEqual(monthly.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]), [["Cursor models", 12.5, 1793900000], ["Other models", 80, 1793900000]], "int64 as a string, ms to seconds");
  const weekly = cursorFrom(usage, { planInfo: { includedUsagePeriod: "INCLUDED_USAGE_PERIOD_WEEKLY", includedUsageResetsAt: "1793500000000" } }, 1);
  assert.equal(weekly.windows[0]?.resetsAt, 1793500000);
  assert.equal(weekly.windows[0]?.windowMinutes, 10080);
  // No split: the editor's own sum, from the money.
  assert.deepEqual(cursorFrom({ planUsage: { includedSpend: 500, limit: 2000, totalPercentUsed: 99 } }, null).windows.map((w) => [w.label, w.usedPercent]), [["Included", 25]]);
  assert.deepEqual(cursorFrom({ planUsage: { totalPercentUsed: "40" } }, null).windows.map((w) => w.usedPercent), [40]);
  // A plan with no usage to show (Cursor: "not available for this plan").
  assert.deepEqual(cursorFrom({}, { planInfo: { planName: "Free" } }), { windows: [], plan: "Free" });
});
