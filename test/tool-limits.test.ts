// The other coding tools' limits (tool-limits.ts), from the answers each tool's own server gives: Kiro, Devin, Cline and Kilo as
// their servers answered real accounts (October 2026, ids left out), Gemini CLI and Grok Build as their source says, Droid and Amp
// as the open-source usage trackers record them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ampFrom, clineFrom, devinFrom, droidFrom, geminiFrom, grokFrom, kiloFrom, kiroFrom } from "../src/runner/tool-limits.js";

test("Kiro: this month's credits, used of the plan's, and the plan by name", () => {
  const a = kiroFrom({
    nextDateReset: 1793491200,
    subscriptionInfo: { subscriptionTitle: "KIRO FREE", type: "Q_DEVELOPER_STANDALONE_FREE" },
    usageBreakdownList: [{ resourceType: "CREDIT", displayName: "Credit", currentUsageWithPrecision: 0.35, usageLimitWithPrecision: 50, nextDateReset: 1793491200, bonuses: [] }],
  });
  assert.equal(a.plan, "Free");
  assert.equal(a.windows.length, 1);
  assert.equal(a.windows[0]!.label, "Monthly credits");
  assert.equal(Math.round(a.windows[0]!.usedPercent! * 10) / 10, 0.7);
  assert.equal(a.windows[0]!.resetsAt, 1793491200);
});

test("Devin: today's and this week's quota, a missing percentage meaning none left, extra usage in dollars", () => {
  const a = devinFrom({
    userStatus: {
      planStatus: {
        planInfo: { planName: "Pro" },
        dailyQuotaRemainingPercent: 64,
        dailyQuotaResetAtUnix: "1791792000",
        weeklyQuotaResetAtUnix: "1792310400",
        overageBalanceMicros: "2500000",
      },
    },
  });
  assert.equal(a.plan, "Pro");
  assert.deepEqual(a.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]), [["Daily", 36, 1791792000], ["Weekly", 100, 1792310400]]);
  assert.equal(a.balanceUsd, 2.5);
  assert.deepEqual(devinFrom({ userStatus: { planStatus: { hideDailyQuota: true, dailyQuotaResetAtUnix: "1", weeklyQuotaRemainingPercent: 100, weeklyQuotaResetAtUnix: "2" } } }).windows.map((w) => w.label), ["Weekly"], "Max plans have the week only");
});

test("Cline and Kilo sell credits: a balance in dollars, and a plan where there is one", () => {
  // `at` is when it was read; a second read a millisecond later would differ, so it is checked apart.
  const { at, ...cline } = clineFrom({ success: true, data: { balance: 366582 } }, null);
  assert.deepEqual(cline, { plan: "Pay as you go", windows: [], balanceUsd: 0.366582 });
  assert.equal(typeof at, "number");
  assert.equal(clineFrom({ data: { balance: 0 } }, { data: { displayName: "ClinePass" } }).plan, "ClinePass");
  const free = kiloFrom({ balance: 0, isDepleted: true }, [{ result: { data: { subscription: null } } }]);
  assert.deepEqual([free.plan, free.balanceUsd, free.windows.length], ["Credits", 0, 0]);
  const pass = kiloFrom({ balance: 3.2 }, [{ result: { data: { subscription: { currentPeriodUsageUsd: 12, currentPeriodBaseCreditsUsd: 19, currentPeriodBonusCreditsUsd: 1, nextBillingAt: "2026-11-02T00:00:00Z", status: "active" } } } }]);
  assert.equal(pass.plan, "Kilo Pass");
  assert.deepEqual([pass.windows[0]!.usedPercent, pass.windows[0]!.resetsAt], [60, Date.parse("2026-11-02T00:00:00Z") / 1000]);
});

test("Gemini CLI: each model's bucket, the fullest first, under the account's tier", () => {
  const a = geminiFrom(
    {
      buckets: [
        { modelId: "gemini-3-pro", remainingFraction: 0.25, resetTime: "2026-10-12T07:00:00Z", tokenType: "REQUESTS" },
        { modelId: "gemini-3-flash", remainingFraction: 0.9, resetTime: "2026-10-12T07:00:00Z", tokenType: "REQUESTS" },
      ],
    },
    { currentTier: { name: "Gemini Code Assist Standard" } },
  );
  assert.equal(a.plan, "Gemini Code Assist Standard");
  assert.deepEqual(a.windows.map((w) => [w.label, Math.round(w.usedPercent!)]), [["Gemini 3-pro", 75], ["Gemini 3-flash", 10]]);
});

test("Grok Build: the week's credits used, and prepaid credits left", () => {
  const a = grokFrom({ config: { creditUsagePercent: 41.7, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-06T00:00:00Z", end: "2026-10-13T00:00:00Z" }, prepaidBalance: { val: 500 } } });
  assert.deepEqual([a.windows[0]!.label, a.windows[0]!.usedPercent, a.windows[0]!.windowMinutes, a.balanceUsd], ["Weekly", 41, 10080, 5]);
});

test("Factory Droid: five hours, week and month for its models and Core apart, an ended window shown empty", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const a = droidFrom({
    limits: { standard: { fiveHour: { usedPercent: 30, windowEnd: future }, weekly: { usedPercent: 55, windowEnd: future } }, core: { fiveHour: { usedPercent: 80, windowEnd: "2026-01-01T00:00:00Z" } } },
    extraUsageBalanceCents: 1250,
  });
  assert.deepEqual(a.windows.map((w) => [w.label, w.usedPercent]), [["5h", 30], ["Weekly", 55], ["5h · Core", 0]]);
  assert.equal(a.balanceUsd, 12.5);
});

test("Amp: its balance line read as the plan, the period's agent credits, and credits bought", () => {
  const paid = ampFrom("Amp Megawatt Tier: agent usage $18.57 of $20 remaining (93%), orb usage 732.8h of 750h a1.small orb hours remaining (98%) - period 2026-09-13 to 2026-10-13, resets upon renewal in 27 days");
  assert.equal(paid.plan, "Megawatt");
  assert.equal(Math.round(paid.windows[0]!.usedPercent!), 7);
  assert.ok(paid.windows[0]!.resetsAt! > Date.now() / 1000 + 26 * 86_400);
  const free = ampFrom("Amp Free: $4.71/$10 remaining (replenishes +$0.42/hour)");
  assert.deepEqual([free.plan, Math.round(free.windows[0]!.usedPercent!), free.windows[0]!.resetsAt], ["Free", 53, null]);
  assert.equal(ampFrom("Individual credits: $25.64 remaining").balanceUsd, 25.64);
});
