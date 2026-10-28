import assert from "node:assert/strict";
import test from "node:test";
import { limitHit, planLimitHit } from "../src/limit-reset.js";
import type { EventBody, SessionEvent } from "../src/types.js";

// 2026-10-11 10:00 in New York (14:00 UTC).
const NOW = Date.UTC(2026, 9, 11, 14, 0);
const NY = "America/New_York";

test("not a limit: nothing to read", () => {
  assert.equal(limitHit(undefined, NOW), null);
  assert.equal(limitHit("Error: Cannot find module 'x'", NOW), null);
});

test("Claude Code's ways of saying when it resets", () => {
  assert.deepEqual(limitHit("Claude AI usage limit reached|1760000000", NOW), { resetsAt: 1760000000_000 });
  assert.equal(limitHit("5-hour limit reached ∙ resets 3pm", NOW, NY)!.resetsAt, Date.UTC(2026, 9, 11, 19, 0), "3pm today, their time");
  assert.equal(limitHit("You've hit your limit · resets 3pm (America/Los_Angeles)", NOW, NY)!.resetsAt, Date.UTC(2026, 9, 11, 22, 0), "the zone it names wins");
  assert.equal(limitHit("5-hour limit reached ∙ resets 9am", NOW, NY)!.resetsAt, Date.UTC(2026, 9, 12, 13, 0), "9am has passed today: tomorrow's");
  assert.equal(limitHit("Weekly limit reached ∙ resets Oct 14, 3pm", NOW, NY)!.resetsAt, Date.UTC(2026, 9, 14, 19, 0));
  assert.equal(limitHit("Claude usage limit reached. Your limit will reset at 15:30 (UTC).", NOW, NY)!.resetsAt, Date.UTC(2026, 9, 11, 15, 30));
});

test("Codex and others: a span, or a time", () => {
  assert.equal(limitHit("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes.", NOW)!.resetsAt, NOW + (2 * 60 + 13) * 60_000);
  assert.equal(limitHit("429 Too Many Requests: retry after 37s", NOW)!.resetsAt, NOW + 37_000);
  assert.equal(limitHit("You've hit your usage limit. Try again at Oct 14th, 2026 3:04 PM.", NOW, NY)!.resetsAt, Date.UTC(2026, 9, 14, 19, 4));
});

test("a limit with no time in it is still a limit", () => {
  assert.deepEqual(limitHit("Quota exceeded for this project.", NOW), { resetsAt: null });
  assert.deepEqual(limitHit("rate limit: 3 requests left", NOW), { resetsAt: null }, "a count is not a time");
});

test("out of usage, the hand-off suggests an agent on another account, and says why", async () => {
  const { project } = await import("../src/session/projection.js");
  const { reasonFor, suggestTarget } = await import("../src/client/handoff-ui.js");
  let seq = 0;
  const ada = { id: "Ada", name: "Ada", kind: "human" as const };
  const ev = (body: EventBody, lane?: string): SessionEvent => ({ seq: ++seq, ts: seq, actor: ada, body, ...(lane ? { lane } : {}) });
  const lane = (id: string, name: string) => ev({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } });
  const state = project("s", [
    ev({ type: "session.created", title: "t", ownerId: "Ada", ownerName: "Ada", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody),
    lane("cc1", "Claude Code"),
    ev({ type: "engine.attached", engine: { tool: "claude", hostId: "h1", hostName: "Ada", cwd: "/w", mode: "full" } }, "cc1"),
    lane("cc2", "Claude Code 2"),
    ev({ type: "engine.attached", engine: { tool: "claude", hostId: "h1", hostName: "Ada", cwd: "/w", mode: "full" } }, "cc2"),
    lane("cx", "Codex"),
    ev({ type: "engine.attached", engine: { tool: "codex", hostId: "h1", hostName: "Ada", cwd: "/w", mode: "full" } }, "cx"),
  ]);
  const signals = { changed: ["a.ts"], tests: null, failing: 0, limited: true };
  const pick = suggestTarget(state, "cc1", ["cc2", "cx"], signals);
  assert.deepEqual(pick, { id: "cx", why: "Claude Code is out of usage; this one isn't" }, "another Claude Code on the same computer is the same sign-in");
  assert.match(reasonFor("Claude Code", "Codex", signals), /ran out of usage partway through, after changing 1 file\. Codex picks it up/);
});

test("a date with no time is not split into a day and an hour", () => {
  const now = Date.UTC(2026, 9, 12, 12, 0);
  // "Oct 14" used to read as Oct 1 at 4 o'clock, already past, so a year later.
  assert.equal(limitHit("Weekly limit reached - resets Oct 14", now, "UTC")?.resetsAt ?? null, null);
  assert.equal(limitHit("Weekly limit reached - resets Oct 14, 3pm", now, "UTC")?.resetsAt, Date.UTC(2026, 9, 14, 15, 0));
});

test("an account's allowance spent, told from a limit gone in a minute (2026-10-27 audit: a per-minute 429 switched a teammate for five hours)", () => {
  for (const e of [
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    "stream error: too many requests, please retry",
    "Error: Request failed (429)",
    "Rate limit exceeded, retry in 37s",
  ]) {
    assert.ok(limitHit(e, NOW), `a limit: ${e}`);
    assert.equal(planLimitHit(e, NOW), null, e);
  }
  for (const e of ["Claude AI usage limit reached|1960000000", "You've hit your usage limit. Try again in 2 hours.", "5-hour limit reached ∙ resets 3pm", "Weekly limit reached - resets Oct 14, 3pm"]) assert.ok(planLimitHit(e, NOW), e);
  // Any limit with its reset hours off is the allowance's, whatever it calls itself.
  assert.equal(planLimitHit("rate limit: try again in 3 hours", NOW)?.resetsAt, NOW + 3 * 3_600_000);
});
