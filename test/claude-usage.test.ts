import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Claude Code asked for its own usage (runner/limits.ts), against a stand-in that answers the way Claude Code 2.1 does: its
// initialize, its `get_usage`, and `/usage` for one too old for that. Nothing here starts the real Claude Code.
const home = await mkdtemp(path.join(tmpdir(), "claude-usage-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.FRIDAY_STATE_DIR = path.join(home, "state");
process.env.FRIDAY_CODEX_BIN = path.join(home, "no-codex");
process.env.APPDATA = home;
process.env.XDG_CONFIG_HOME = home;
delete process.env.CODEX_HOME;
const log = path.join(home, "fake.log");
const modeFile = path.join(home, "mode");
const usageFile = path.join(home, "usage.json");
process.env.FAKE_LOG = log;
process.env.FAKE_MODE_FILE = modeFile;
process.env.FAKE_USAGE_FILE = usageFile;

const FAKE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const read = (f, d) => { try { return readFileSync(f, "utf8").trim(); } catch { return d; } };
const mode = read(process.env.FAKE_MODE_FILE, "ok");
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), dir: process.env.CLAUDE_CONFIG_DIR ?? "", mode }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (args.includes("/usage")) {
  out({ type: "result", subtype: "success", is_error: false, session_id: "fake-session", result: "You are currently using your subscription\\n\\nCurrent session: 50% used · resets Oct 28 at 4pm (America/New_York)\\nCurrent week (all models): 20% used · resets Oct 31 at 8pm (America/New_York)\\nCurrent week (Fable): 43% used · resets Oct 31 at 8pm (America/New_York)\\n\\nLast 24h · 12 requests" });
  process.exit(0);
}
const reply = (id, response) => out({ type: "control_response", response: { subtype: "success", request_id: id, response } });
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const sub = m.request?.subtype;
    if (sub === "initialize") reply(m.request_id, { account: mode === "apikey" ? { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" } : mode === "signedout" ? { tokenSource: "none", apiProvider: "firstParty" } : { subscriptionType: "Claude Max" } });
    else if (sub === "get_usage" && mode === "unsupported") out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Unsupported control request subtype: get_usage" } });
    else if (sub === "get_usage" && (mode === "apikey" || mode === "signedout")) reply(m.request_id, { subscription_type: null, rate_limits_available: false, rate_limits: null });
    else if (sub === "get_usage" && mode === "ok") reply(m.request_id, JSON.parse(read(process.env.FAKE_USAGE_FILE, "{}")));
  }
});
process.stdin.on("end", () => process.exit(0));
`;
const fake = path.join(home, "fake-claude.mjs");
await writeFile(fake, FAKE);
await chmod(fake, 0o755);
process.env.FRIDAY_CLAUDE_BIN = fake;

const { CLAUDE_ASK, askClaudeUsage, claudeResetText, claudeUsageFrom, claudeUsageText, noteClaudeEvent, noteClaudeStarting, readLimits } = await import("../src/runner/limits.js");
const { accountDir } = await import("../src/runner/accounts.js");
CLAUDE_ASK.everyMs = 400;
CLAUDE_ASK.backOffMs = 1200;
CLAUDE_ASK.probeMs = 1500;
CLAUDE_ASK.startingMs = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const starts = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; cwd: string; dir: string; mode: string });
const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** What Claude Code 2.1.307 answered on a Team plan (2026-10-28), nulls left out: the session, and Fable's own week. */
const TEAM = {
  session: { total_cost_usd: 0 },
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 67, resets_at: "2026-10-28T20:00:00.397411+00:00" },
    seven_day: null,
    extra_usage: { is_enabled: false, user_disabled: false, spend_limit_reached: false },
    limits: [
      { kind: "session", group: "session", percent: 67, resets_at: "2026-10-28T20:00:00.397411+00:00", severity: "normal", is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 43, resets_at: "2026-11-01T00:00:00.397649+00:00", severity: "normal", is_active: false, scope: { model: { display_name: "Fable" } } },
    ],
    spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, percent: 0, enabled: false },
    model_scoped: [{ display_name: "Fable", utilization: 43, resets_at: "2026-11-01T00:00:00.397649+00:00" }],
  },
};

test("get_usage's answer as Friday's windows: the session, the week, a model's own week, extra usage, and the plan", () => {
  const team = claudeUsageFrom(TEAM, 1);
  assert.equal(team?.available, true);
  assert.equal(team?.plan, "Team");
  assert.equal(team?.scoped, "Fable");
  assert.deepEqual(
    team?.windows.map((w) => [w.kind, w.label ?? null, w.utilization, w.resetsAt]),
    [
      ["five_hour", null, 0.67, 1793217600],
      ["seven_day_fable", "Weekly · Fable", 0.43, 1793491200],
    ],
    "0-100 as fractions, ISO resets as seconds; a week left null is no window, not 0%",
  );
  const max = claudeUsageFrom({
    subscription_type: "max_20x",
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12.5, resets_at: iso(2) }, seven_day: { utilization: 80, resets_at: iso(50) }, seven_day_opus: { utilization: 5, resets_at: iso(50) }, extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 1000 } },
  });
  assert.equal(max?.plan, "Max 20x");
  assert.deepEqual(max?.windows.map((w) => [w.kind, w.utilization]), [["five_hour", 0.125], ["seven_day", 0.8], ["seven_day_opus", 0.05], ["overage", 0.25]]);
  assert.equal(max?.windows.find((w) => w.kind === "overage")?.label, "Extra usage");
  // Spend in money wins over the credits, when both are in one currency.
  const spend = claudeUsageFrom({ rate_limits_available: true, rate_limits: { spend: { enabled: true, used: { amount_minor: 500, currency: "USD", exponent: 2 }, limit: { amount_minor: 2000, currency: "USD", exponent: 2 } }, extra_usage: { is_enabled: true, utilization: 90 } } });
  assert.deepEqual(spend?.windows.map((w) => [w.kind, w.utilization]), [["overage", 0.25]]);
  assert.deepEqual(claudeUsageFrom({ subscription_type: null, rate_limits_available: false, rate_limits: null }), { available: false, plan: null, windows: [], scoped: null }, "an API key: no plan limits");
  assert.equal(claudeUsageFrom("nope"), null);
});

test("/usage's text, for a Claude Code too old for get_usage: each window, its reset read in the zone it names", () => {
  const now = Date.parse("2026-10-28T17:00:00Z");
  assert.equal(claudeResetText("Oct 28 at 4pm (America/New_York)", now), Date.parse("2026-10-28T20:00:00Z") / 1000, "the same moment get_usage gives");
  assert.equal(claudeResetText("Oct 31 at 8pm (America/New_York)", now), Date.parse("2026-11-01T00:00:00Z") / 1000);
  assert.equal(claudeResetText("Nov 3 at 3:59pm (America/New_York)", now), Date.parse("2026-11-03T20:59:00Z") / 1000, "after the clocks change, EST");
  assert.equal(claudeResetText("Jan 2 at 9am (Europe/London)", now), Date.parse("2027-01-02T09:00:00Z") / 1000, "no year, and well past this year's: next year's");
  assert.equal(claudeResetText("4pm (America/New_York)", Date.parse("2026-10-28T21:00:00Z")), Date.parse("2026-10-29T20:00:00Z") / 1000, "a time alone, already past: tomorrow's");
  assert.equal(claudeResetText("whenever"), null);
  const text = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 69% used · resets Oct 28 at 4pm (America/New_York)\nCurrent week (Fable): 43% used · resets Oct 31 at 8pm (America/New_York)\n\nLast 24h · 6471 requests · 27 sessions\n  93%  Stop sessions you no longer need";
  assert.deepEqual(
    claudeUsageText(text, now).map((w) => [w.kind, w.label ?? null, w.utilization, w.resetsAt]),
    [
      ["five_hour", null, 0.69, 1793217600],
      ["seven_day_fable", "Weekly · Fable", 0.43, 1793491200],
    ],
    "the tips under it, with their own percentages, are not windows",
  );
});

test("asked of Claude Code when the limits are read: once per five minutes, in Friday's own folder, with nothing of the person's loaded", async () => {
  await writeFile(usageFile, JSON.stringify(TEAM));
  await writeFile(modeFile, "ok");
  const l = await readLimits();
  assert.equal(l.claudePlan, "Team");
  assert.equal(l.claudeFrom, "account");
  assert.equal(l.claudeWhy, undefined);
  assert.deepEqual(l.claudeWindows.map((w) => [w.kind, w.utilization]), [["five_hour", 0.67], ["seven_day_fable", 0.43]]);
  const [first] = await starts();
  assert.equal(first?.cwd, await realpath(path.join(home, "state", "claude-usage")), "its own empty folder under Friday's data, not the project");
  for (const flag of ["-p", "--input-format", "--strict-mcp-config", "--no-session-persistence", "--settings", "--tools"]) assert.ok(first!.args.includes(flag), flag);
  assert.equal(first!.args[first!.args.indexOf("--tools") + 1], "", "no tools");
  assert.equal(first!.args[first!.args.indexOf("--settings") + 1], '{"disableAllHooks":true}', "no hooks");
  await readLimits();
  await readLimits({ askClaude: false });
  assert.equal((await starts()).length, 1, "not again within its five minutes");
  await sleep(CLAUDE_ASK.everyMs + 50);
  await readLimits({ askClaude: false });
  assert.equal((await starts()).length, 1, "a lane sharing its limits never asks");
  noteClaudeStarting();
  await readLimits();
  assert.equal((await starts()).length, 1, "not while Friday is starting Claude Code for a turn");
  await sleep(CLAUDE_ASK.startingMs);
});

test("the stream and the ask update the same windows, the newer winning, a model's week found by the name the ask gave it", async () => {
  // Its stream's name for Fable's week.
  noteClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day_overage_included", utilization: 0.5, resetsAt: 1793491200 } });
  noteClaudeEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.3, resetsAt: 1793491200 } });
  await sleep(150);
  let l = await readLimits({ askClaude: false });
  const fable = l.claudeWindows.find((w) => w.kind === "seven_day_fable");
  assert.equal(fable?.utilization, 0.5, "the stream's newer figure");
  assert.equal(fable?.label, "Weekly · Fable", "and still called by its name");
  assert.ok(!l.claudeWindows.some((w) => w.kind === "seven_day_overage_included"));
  // Asked again later: the ask is newer now, and a week it doesn't list (this plan has none) is gone.
  await sleep(CLAUDE_ASK.everyMs + 50);
  await readLimits();
  l = await readLimits({ askClaude: false });
  assert.deepEqual(l.claudeWindows.map((w) => [w.kind, w.utilization]), [["five_hour", 0.67], ["seven_day_fable", 0.43]]);
  assert.equal((await starts()).length, 2);
});

test("a Claude Code that can't answer get_usage is read from /usage, then left alone for half an hour", async () => {
  await rm(log, { force: true });
  await writeFile(modeFile, "unsupported");
  await sleep(CLAUDE_ASK.everyMs + 50);
  const l = await readLimits();
  const said = await starts();
  assert.deepEqual(said.map((s) => s.args.includes("/usage")), [false, true], "get_usage first, then /usage");
  assert.ok(said[1]!.args.includes("--no-session-persistence"));
  assert.deepEqual(l.claudeWindows.map((w) => [w.kind, w.utilization]), [["five_hour", 0.5], ["seven_day", 0.2], ["seven_day_fable", 0.43]]);
  await sleep(CLAUDE_ASK.everyMs + 50);
  await readLimits();
  assert.equal((await starts()).length, 2, "backed off");
  await sleep(CLAUDE_ASK.backOffMs);
  await readLimits();
  assert.equal((await starts()).length, 4, "asked again after it");
});

test("one that doesn't answer is stopped, and backed off; signed out says so quietly; on an API key there are no plan limits", async () => {
  await rm(log, { force: true });
  await writeFile(modeFile, "slow");
  await sleep(CLAUDE_ASK.backOffMs);
  const t0 = Date.now();
  await askClaudeUsage();
  assert.ok(Date.now() - t0 < CLAUDE_ASK.probeMs + 1000, "stopped at its time limit");
  await askClaudeUsage();
  assert.equal((await starts()).length, 1, "not asked again straight after a failure");

  // Each account is asked as itself, one at a time.
  await writeFile(modeFile, "signedout");
  await askClaudeUsage("work");
  assert.equal((await starts()).at(-1)?.dir, accountDir("claude", "work"));
  const store = JSON.parse(await readFile(path.join(home, "state", "claude-limits.json"), "utf8")) as { byAccount: Record<string, unknown>; asked: Record<string, { available: boolean }> };
  assert.equal(store.asked.work, undefined, "signed out: nothing kept, no 'API key' claimed");

  await writeFile(modeFile, "apikey");
  await sleep(CLAUDE_ASK.backOffMs);
  const l = await readLimits();
  assert.deepEqual(l.claudeWindows, [], "no plan limits shown");
  assert.match(l.claudeWhy ?? "", /API key/);
  assert.equal(l.claudePlan, null);
});
