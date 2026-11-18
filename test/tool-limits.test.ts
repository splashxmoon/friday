// The other coding tools' limits (tool-limits.ts), from the answers each tool's own server gives: Kiro, Devin, Cline and Kilo as
// their servers answered real accounts (October 2026, ids left out), Gemini CLI and Grok Build as their source says, Droid and Amp
// as the open-source usage trackers record them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agyLoginFrom, ampFrom, antigravityFrom, antigravityModelsFrom, asOfNow, clineFrom, devinFrom, droidFrom, geminiFrom, grokFrom, kiloFrom, kiroFrom, opencodeGoFrom } from "../src/runner/tool-limits.js";
import { codexFromSnapshot, codexFromWham } from "../src/runner/limits.js";

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

test("Antigravity: `agy -p /usage --output-format json`, each group's five hours and week as windows of their own (issue #30)", () => {
  const a = antigravityFrom({
    type: "result",
    num_turns: 0,
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-5h", window: "5h", remaining_fraction: 0.42, reset_time: "2026-11-18T20:00:00Z" },
              { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.91, reset_time: "2026-11-23T00:00:00Z" },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              { id: "claude-gpt-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-11-18T21:30:00Z" },
              { id: "claude-gpt-weekly", window: "weekly", remaining_fraction: 0.25, reset_time: "2026-11-23T00:00:00Z" },
            ],
          },
        ],
      },
    },
  }, Date.parse("2026-11-18T12:00:00Z"))!;
  assert.deepEqual(
    a.windows.map((w) => [w.kind, w.label, w.windowMinutes, Math.round(w.usedPercent!), w.resetsAt]),
    [
      ["gemini-5h", "5h · Gemini", 300, 58, Date.parse("2026-11-18T20:00:00Z") / 1000],
      ["gemini-weekly", "Weekly · Gemini", 10080, 9, Date.parse("2026-11-23T00:00:00Z") / 1000],
      ["claude-gpt-5h", "5h · Claude and GPT", 300, 0, Date.parse("2026-11-18T21:30:00Z") / 1000],
      ["claude-gpt-weekly", "Weekly · Claude and GPT", 10080, 75, Date.parse("2026-11-23T00:00:00Z") / 1000],
    ],
  );
  assert.equal(a.plan, null);
  // A bucket without a fraction says nothing; an answer without groups isn't a usage answer at all.
  assert.equal(antigravityFrom({ command: { data: { groups: [{ name: "Gemini Models", buckets: [{ id: "x", window: "5h" }] }] } } }), null);
  assert.equal(antigravityFrom({ type: "result", result: "Unknown command /usage" }), null);
  // camelCase names, as its other answers sometimes use, read the same.
  assert.equal(antigravityFrom({ command: { data: { groups: [{ name: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.5, resetTime: 1795000000 }] }] } } })!.windows[0]!.usedPercent, 50);
});

test("Antigravity: Google's own quota summary, as agy asks it (camelCase, disabled buckets left out, an untouched one with no reset)", () => {
  const at = Date.parse("2026-11-18T12:00:00Z");
  const a = antigravityFrom(
    {
      groups: [
        { displayName: "Gemini Models", buckets: [
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.25, resetTime: "2026-11-18T13:30:00Z" },
          { bucketId: "gemini-carbon-5h", window: "5h", remainingFraction: 0.5, resetTime: "2026-11-18T13:00:00Z", disabled: true },
        ] },
        { displayName: "Claude and GPT models", buckets: [
          // Untouched: full, and its reset a whole window from when it was asked.
          { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-18T17:00:00Z" },
          { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.1, resetTime: "2026-11-23T00:00:00Z" },
        ] },
      ],
    },
    at,
  )!;
  assert.deepEqual(
    a.windows.map((w) => [w.kind, w.label, Math.round(w.usedPercent!), w.resetsAt]),
    [
      ["gemini-5h", "5h · Gemini", 75, Date.parse("2026-11-18T13:30:00Z") / 1000],
      ["3p-5h", "5h · Claude and GPT", 0, null],
      ["3p-weekly", "Weekly · Claude and GPT", 90, Date.parse("2026-11-23T00:00:00Z") / 1000],
    ],
  );
  // Top-level buckets, when no group has any.
  assert.equal(antigravityFrom({ buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5 }] })!.windows[0]!.usedPercent, 50);
});

test("Antigravity: agy's own sign-in, as its keyring keeps it (go-keyring's encodings, the older shape)", () => {
  const stored = { auth_method: "oauth-personal", token: { access_token: "at-1", token_type: "Bearer", refresh_token: "rt", expiry: "2026-11-18T13:00:00Z" }, project_id: "proj-9", tier_display_name: "Google AI Pro" };
  const want = { authMethod: "oauth-personal", accessToken: "at-1", expiresAt: Date.parse("2026-11-18T13:00:00Z"), projectId: "proj-9", tier: "Google AI Pro" };
  assert.deepEqual(agyLoginFrom(JSON.stringify(stored)), want);
  assert.deepEqual(agyLoginFrom(`go-keyring-base64:${Buffer.from(JSON.stringify(stored)).toString("base64")}`), want);
  assert.deepEqual(agyLoginFrom(`go-keyring-encoded:${Buffer.from(JSON.stringify(stored)).toString("hex")}`), want);
  assert.equal(agyLoginFrom(JSON.stringify({ access_token: "at-2", expiry: "2026-11-18T13:00:00Z" }))!.accessToken, "at-2");
  assert.equal(agyLoginFrom("not json"), null);
  assert.equal(agyLoginFrom(JSON.stringify({ token: {} })), null);
});

test("OpenCode Go: its rolling five hours, week and month; a limited window full", () => {
  const a = opencodeGoFrom({ usage: { rolling: { percent: 12.5, resetsAt: "2026-11-18T15:00:00Z" }, weekly: { percent: 40, resetsAt: "2026-11-23T00:00:00Z" }, monthly: { limited: true, resetsAt: "2026-12-01T00:00:00Z" } } })!;
  assert.deepEqual(a.windows.map((w) => [w.label, w.usedPercent, w.windowMinutes]), [["5h", 12.5, 300], ["Weekly", 40, 10080], ["Monthly", 100, 43200]]);
  assert.equal(a.plan, "OpenCode Go");
  assert.equal(opencodeGoFrom({ usage: {} }), null);
});

test("Grok Build: fields at the top level, nothing used yet this week, the month's spend", () => {
  const end = "2026-11-23T00:00:00Z";
  const a = grokFrom({ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end }, monthlyLimit: { val: 3000 }, used: { val: 750 }, billingPeriodEnd: "2026-12-01T00:00:00Z", subscriptionTier: "SuperGrok" });
  assert.deepEqual(a.windows.map((w) => [w.label, w.usedPercent]), [["Weekly", 0], ["Monthly", 25]]);
  assert.equal(a.plan, "SuperGrok");
});

test("Devin: snake_case answers read the same, and a quota the plan hides is left out", () => {
  const a = devinFrom({ user_status: { plan_status: { daily_quota_remaining_percent: 70, daily_quota_reset_at_unix: 1795000000, weekly_quota_remaining_percent: 20, weekly_quota_reset_at_unix: 1795400000, plan_info: { plan_name: "Pro", hide_daily_quota: true } } } });
  assert.deepEqual(a.windows.map((w) => [w.label, w.usedPercent]), [["Weekly", 80]]);
  assert.equal(a.plan, "Pro");
});

test("A kept reading whose window has reset since shows that window empty, with no reset", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const a = asOfNow({ plan: null, at: now - 3_600_000, windows: [
    { kind: "5h", label: "5h", windowMinutes: 300, usedPercent: 80, resetsAt: (now - 60_000) / 1000, at: now - 3_600_000 },
    { kind: "w", label: "Weekly", windowMinutes: 10080, usedPercent: 30, resetsAt: (now + 86_400_000) / 1000, at: now - 3_600_000 },
  ] }, now);
  assert.deepEqual(a.windows.map((w) => [w.usedPercent, w.resetsAt]), [[0, null], [30, (now + 86_400_000) / 1000]]);
});

test("Codex: ChatGPT's own usage answer reads as the app server's; a monthly credit limit; a window without its length", () => {
  const at = Date.parse("2026-11-18T12:00:00Z");
  const w = codexFromWham({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1795000000 }, secondary_window: { used_percent: 93, limit_window_seconds: 604800, reset_after_seconds: 3600 } } }, at)!;
  assert.deepEqual(w.windows.map((x) => [x.label, x.usedPercent, x.resetsAt]), [["5-hour", 12, 1795000000], ["Weekly", 93, at / 1000 + 3600]]);
  assert.equal(w.plan, "Plus");
  const m = codexFromSnapshot({ planType: "business", individualLimit: { remainingPercent: 35, resetsAt: 1796000000 } }, at)!;
  assert.deepEqual(m.windows.map((x) => [x.label, x.usedPercent, x.windowMinutes]), [["Monthly", 65, 43200]]);
  const free = codexFromSnapshot({ planType: "free", primary: { usedPercent: 10, resetsAt: 1796000000 } }, at)!;
  assert.deepEqual(free.windows.map((x) => [x.label, x.windowMinutes]), [["Monthly", 43200]]);
});

test("Antigravity's models' quotas stand in for a free account's refused summary, grouped as agy groups them", () => {
  const at = Date.parse("2026-11-18T18:17:54Z");
  const models = {
    // A week off, touched: the Gemini week, its most used model standing for it.
    "gemini-3.1-flash-image": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.9872528, resetTime: "2026-11-25T18:14:38Z" } },
    "gemini-3.8-flash-high": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1, resetTime: "2026-11-25T18:17:54Z" } },
    // Five hours off and untouched: left out, as agy leaves it out.
    "gemini-2.5-pro": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1, resetTime: "2026-11-18T23:17:54Z" } },
    // Claude and GPT share a week; untouched, it keeps no reset.
    "claude-sonnet-4-6": { modelProvider: "MODEL_PROVIDER_ANTHROPIC", quotaInfo: { remainingFraction: 1, resetTime: "2026-11-25T18:17:54Z" } },
    "gpt-oss-120b-medium": { modelProvider: "MODEL_PROVIDER_OPENAI", quotaInfo: { remainingFraction: 1, resetTime: "2026-11-25T18:17:54Z" } },
    // No reset, or no quota: not a window.
    chat_20706: { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1 } },
    "gemini-4-argon-disabled": { modelProvider: "MODEL_PROVIDER_GOOGLE" },
  };
  const a = antigravityModelsFrom({ models }, at)!;
  assert.deepEqual(
    a.windows.map((w) => [w.kind, w.label, Math.round(w.usedPercent! * 100) / 100, w.resetsAt, w.windowMinutes]),
    [
      ["gemini-weekly", "Weekly · Gemini", 1.27, Date.parse("2026-11-25T18:14:38Z") / 1000, 10080],
      ["3p-weekly", "Weekly · Claude and GPT", 0, null, 10080],
    ],
  );
  // A five-hour window something has used shows.
  const used = antigravityModelsFrom({ models: { "gemini-2.5-pro": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.4, resetTime: "2026-11-18T21:00:00Z" } } } }, at)!;
  assert.deepEqual(used.windows.map((w) => [w.kind, w.label, Math.round(w.usedPercent!), w.windowMinutes]), [["gemini-5h", "5h · Gemini", 60, 300]]);
  assert.equal(antigravityModelsFrom({ models: {} }, at), null);
  assert.equal(antigravityModelsFrom(null, at), null);
});
