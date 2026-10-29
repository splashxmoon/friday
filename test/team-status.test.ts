// Crew: team round two's client logic (Arun, 2026-10-28: "go all out and improve and make this better").
import assert from "node:assert/strict";
import test from "node:test";
import { ACCESS, dayBreaks, sayMate, untilIn, type MateLike } from "../src/client/team-status.js";
import { teamCommand, toHHMM, TEAM_COMMANDS } from "../src/client/team-commands.js";
import { boardTitle, briefEmpty, nextAt, nextEight, plainError } from "../src/client/team-api.js";

const mate = (over: Partial<MateLike> = {}): MateLike => ({ name: "Kit", tool: "claude", status: "idle", line: "", queued: 0, ...over });

test("one status for everywhere: out of usage puts the time first and names who covers, in the limited state", () => {
  const s = sayMate(mate({ status: "limited", line: "Out of usage until 12:38 PM · same account as Juno" }));
  assert.equal(s.state, "limited");
  assert.equal(s.line, "Out until 12:38 PM · Codex covers");
  assert.equal(sayMate(mate({ status: "limited", line: "Out of usage", backup: "cursor" })).line, "Out of usage · Cursor covers");
  // On one of the person's own models no backup takes it: it waits for that model.
  assert.equal(sayMate(mate({ tool: "friday", status: "limited", line: "until 9:00 PM" }), { model: "Llama" }).line, "Out until 9:00 PM · waits for Llama");
});

test("offline is its own, grey state wherever the teammate is drawn, with what keeps it from running", () => {
  assert.deepEqual(sayMate(mate({ status: "offline" })), { state: "offline", line: "Offline" });
  assert.deepEqual(sayMate(mate({ status: "offline", problem: "Its model is gone from Settings" }), { here: "working" }), { state: "offline", line: "Offline · Its model is gone from Settings" });
});

test("a teammate whose last run failed is stopped, in its own state, saying why in words", () => {
  // Arun, 2026-10-29: "Yes, fix them": its page said "Idle" after a failed run.
  assert.deepEqual(sayMate(mate({ status: "stopped", line: "Stopped: their tool failed to start" })), { state: "stopped", line: "Stopped: their tool failed to start" });
  assert.deepEqual(sayMate(mate({ status: "stopped", line: "" })), { state: "stopped", line: "Stopped" });
  // Working again in the chat drawn, it is working there.
  assert.equal(sayMate(mate({ status: "stopped", line: "Stopped on an error" }), { here: "working" }).state, "working");
});

test("in one chat a teammate busy in another room is idle here, and says where it works", () => {
  const s = sayMate(mate({ status: "working", line: "Using Bash" }), { here: "idle", elsewhere: ["Launch week"] });
  assert.deepEqual(s, { state: "idle", line: "Idle here · working in Launch week" });
  assert.equal(sayMate(mate({ status: "working", line: "Using Bash" })).line, "Using Bash");
});

test("on its backup tool, what it does says which tool it is on; idle, until when", () => {
  const until = new Date(2026, 9, 28, 16, 0).getTime();
  const now = new Date(2026, 9, 28, 12, 0).getTime();
  assert.equal(sayMate(mate({ tool: "codex", status: "working", line: "Editing a.ts", switched: { from: "claude", until } }), { now }).line, "Editing a.ts · on Codex");
  assert.match(sayMate(mate({ tool: "codex", status: "idle", switched: { from: "claude", until } }), { now }).line, /^On Codex until 4:00\sPM · Claude Code out$/);
  assert.equal(sayMate(mate({ status: "waiting", line: "Which date?" })).line, "Needs you: Which date?");
});

test("paused and held say so, with what waits", () => {
  assert.equal(sayMate(mate({ queued: 2 }), { paused: true }).line, "Paused · 2 queued");
  assert.equal(sayMate(mate({ held: true })).line, "On hold");
  assert.equal(sayMate(mate({ queued: 3 })).line, "3 queued");
  assert.equal(untilIn("Out of usage until 10:42 PM"), "10:42 PM");
});

test("access in the person's words, for each mode", () => {
  assert.deepEqual(Object.keys(ACCESS), ["plan", "edits", "full"]);
  assert.equal(ACCESS.plan.label, "Read only");
  assert.equal(ACCESS.edits.label, "Ask before changes");
});

test("day dividers: before each new day, and before the first only when the chat spans more than one", () => {
  const now = new Date(2026, 9, 28, 12).getTime();
  const y = new Date(2026, 9, 27, 18).getTime();
  assert.deepEqual(dayBreaks([now - 60_000, now], now), [null, null]);
  assert.deepEqual(dayBreaks([y, y + 60_000, undefined, now], now), ["Yesterday", null, null, "Today"]);
});

test("team commands: done here, or the words they stand for; anything else is sent as typed", () => {
  assert.deepEqual(teamCommand("/stop"), { kind: "stop" });
  assert.deepEqual(teamCommand("/PAUSE"), { kind: "pause" });
  assert.deepEqual(teamCommand("/away"), { kind: "away", at: "08:00" });
  assert.deepEqual(teamCommand("/away 7pm"), { kind: "away", at: "19:00" });
  assert.equal(teamCommand("/away tomorrow")?.kind, "bad");
  assert.deepEqual(teamCommand("/assign @Kit fix the FAQ"), { kind: "say", text: "@Kit Your task: fix the FAQ" });
  assert.equal(teamCommand("/assign fix it")?.kind, "bad");
  assert.match((teamCommand("/standup") as { text: string }).text, /^@everyone Stand-up/);
  assert.equal(teamCommand("/compact"), null);
  assert.equal(teamCommand("not a command"), null);
  assert.equal(toHHMM("7:30"), "07:30");
  assert.equal(toHHMM("12am"), "00:00");
  assert.ok(TEAM_COMMANDS.every((c) => c.text.startsWith(`/${c.name}`)));
});

test("away mode's end: the next 8:00 AM, or the next time typed", () => {
  const evening = new Date(2026, 9, 28, 22, 15).getTime();
  assert.equal(new Date(nextEight(evening)).getDate(), 29);
  assert.equal(new Date(nextEight(evening)).getHours(), 8);
  const early = new Date(2026, 9, 28, 6, 0).getTime();
  assert.equal(new Date(nextEight(early)).getDate(), 28);
  assert.equal(new Date(nextAt("23:30", evening)!).getDate(), 28);
  assert.equal(nextAt("soon", evening), null);
});

test("never drawn raw: the board's own prefix, a usage limit's token, Friday's mark", () => {
  assert.equal(boardTitle('Board task "repo": GitHub repo audit'), "GitHub repo audit");
  assert.equal(boardTitle("Fix the FAQ"), "Fix the FAQ");
  // A minute from now, so it reads as a time today whatever day the tests run (a fixed one turned into "Wed 12:38 PM" once passed).
  assert.match(plainError(`Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 60}`), /^Out of usage until \d/);
  assert.equal(plainError("rate limit hit (429)"), "Out of usage");
  assert.equal(plainError("[Friday] It stopped"), "It stopped");
  assert.ok(briefEmpty({ since: 0, until: 0, done: [], failed: [], waiting: [], assumptions: [], usage: [{ lane: "l", name: "Kit", turns: 1, minutes: 1 }] }));
});

test("a raw error is never a teammate's live line (Arun, 2026-10-29: \"node:internal/modules/cjs/loader:1…\" as a needs-you line)", () => {
  const raw = "node:internal/modules/cjs/loader:1228 throw err; Error: Cannot find module 'x'";
  assert.equal(sayMate(mate({ status: "waiting", line: raw })).line, "Needs you");
  assert.equal(sayMate(mate({ status: "working", line: raw })).line, "Working");
  assert.equal(sayMate(mate({ status: "offline", line: raw })).line, "Offline");
  assert.equal(plainError(raw), "Stopped: their tool failed to start");
});
