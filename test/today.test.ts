import assert from "node:assert/strict";
import { test } from "node:test";
import { fitLine, landedRow, minutesFor, sortLanded, type LandedRow } from "../src/today.js";
import type { LaterTask } from "../src/later.js";
import type { SessionState } from "../src/session/projection.js";

const task = (o: Partial<LaterTask> = {}): LaterTask => ({ id: "aaaaaaaaaa", ownerId: "u", ownerName: "Arun", folder: "/code/web", ask: "Fix the flaky test", title: "Fix the flaky test", tool: "claude", mode: "full", fullAccess: false, model: "", at: 1000, created: 0, status: "running", sid: "s1", invite: "i", startedAt: 2000, ...o });
const state = (o: Record<string, unknown> = {}): SessionState =>
  ({ id: "s1", title: "Fix the flaky test", run: { status: "idle", sinceSeq: 0 }, laneRuns: {}, lanes: [], engines: {}, options: {}, diffs: {}, ...o }) as unknown as SessionState;
const diff = { main: { seq: 5, files: [{ path: "a.ts", additions: 10, deletions: 2 }, { path: "b.ts", additions: 3, deletions: 0 }] } };

test("landedRow: each state a night's task can be in", () => {
  assert.equal(landedRow(task(), state({ run: { status: "running", sinceSeq: 1 } })).state, "working");
  assert.equal(landedRow(task(), state({ run: { status: "waiting_for_human", sinceSeq: 1 } })).state, "needs");
  const failed = landedRow(task(), state({ run: { status: "error", sinceSeq: 1, error: "Out of usage" } }));
  assert.deepEqual([failed.state, failed.note], ["failed", "Out of usage"]);
  const ready = landedRow(task(), state({ diffs: diff }));
  assert.deepEqual([ready.state, ready.files, ready.additions, ready.deletions], ["ready", 2, 13, 2]);
  assert.equal(landedRow(task(), state()).state, "nothing");
  assert.equal(landedRow(task(), state({ diffs: diff, pr: { url: "https://github.com/a/b/pull/4", merged: false } })).state, "pr");
  assert.equal(landedRow(task(), state({ pr: { url: "https://github.com/a/b/pull/4", merged: true } })).state, "merged");
});

test("landedRow: a missed or failed start says why; a deleted chat is said as gone", () => {
  const missed = landedRow(task({ status: "missed", note: "Friday wasn't running, or this computer was asleep.", sid: undefined, startedAt: undefined }), null);
  assert.deepEqual([missed.state, missed.note, missed.startedAt], ["failed", "Friday wasn't running, or this computer was asleep.", 1000]);
  assert.equal(landedRow(task(), null).state, "gone");
});

test("sortLanded: what needs you first, then failures, then finished work, newest first within each", () => {
  const r = (state: LandedRow["state"], startedAt: number) => ({ task: `${state}${startedAt}`, title: "", folder: "", tool: "claude" as const, startedAt, state });
  assert.deepEqual(sortLanded([r("working", 1), r("ready", 1), r("ready", 2), r("failed", 1), r("needs", 1)]).map((x) => x.task), ["needs1", "failed1", "ready2", "ready1", "working1"]);
});

test("minutesFor: a found task by its size, anything else by its words", () => {
  assert.equal(minutesFor({ ask: "anything" }, { size: "XS" }), 10);
  assert.equal(minutesFor({ ask: "anything" }, { size: "M" }), 45);
  assert.ok(minutesFor({ ask: "Rename a variable" }) > 0);
});

test("fitLine: fresh by the start, how full until when, the week nearly gone, or nothing known", () => {
  const at = Date.UTC(2026, 10, 22, 6);
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  assert.equal(fitLine("Claude Code", [{ minutes: 300, used: 80, resetsAt: at / 1000 - 60 }], at, clock), "Claude Code's 5-hour limit is fresh by then");
  assert.equal(fitLine("Claude Code", [{ minutes: 300, used: 72, resetsAt: at / 1000 + 3600 }], at, clock), "Claude Code is at 72% of its 5-hour limit until 07:00");
  assert.equal(fitLine("Codex", [{ minutes: 300, used: 10, resetsAt: at / 1000 + 3600 }], at, clock), "Codex has room in its 5-hour limit");
  assert.equal(fitLine("Codex", [{ minutes: 300, used: 10, resetsAt: at / 1000 + 3600 }, { minutes: 10080, used: 91, resetsAt: null }], at, clock), "Codex has room in its 5-hour limit; its week is at 91%, so tonight may stop early");
  assert.equal(fitLine("Codex", [], at, clock), "");
});

test("landedRow: a run Friday's restart cut off is still working, not failed", () => {
  const r = landedRow(task(), state({ run: { status: "error", sinceSeq: 1, error: "The server restarted in the middle of Claude Code's turn. It picks this up again when it reconnects." } }));
  assert.equal(r.state, "working");
});
