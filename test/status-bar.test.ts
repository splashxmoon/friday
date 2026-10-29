// What the Focus layout's status bar says about the run (StatusBar.tsx).
import assert from "node:assert/strict";
import test from "node:test";
import { barLine, clock, runLine } from "../src/client/StatusBar.js";
import { project } from "../src/session/projection.js";
import type { SessionEvent } from "../src/types.js";

test("a run's length reads like a stopwatch", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(42_000), "0:42");
  assert.equal(clock(12 * 60_000 + 5_000), "12:05");
  assert.equal(clock(3_729_000), "1:02:09");
  assert.equal(clock(-5), "0:00", "a clock behind the server's never goes negative");
});

test("idle is Ready; a run counts its time and the main agent's tools", () => {
  const state = project("s", []);
  assert.deepEqual(runLine(state, [], 0), { tone: "idle", text: "Ready" });

  const at = (seq: number, ts: number, body: SessionEvent["body"], lane?: string): SessionEvent => ({ seq, ts, actor: { kind: "system" } as SessionEvent["actor"], body, ...(lane ? { lane } : {}) });
  const tool = { type: "tool.result", callId: "c", name: "Bash", output: "", isError: false } as SessionEvent["body"];
  const events = [at(4, 1_000, { type: "run.started", causedBy: 3 }), at(5, 2_000, tool), at(6, 3_000, tool), at(7, 4_000, tool, "reviewer")];
  const running = { ...state, run: { status: "running" as const, sinceSeq: 4 } };
  assert.deepEqual(runLine(running, events, 66_000), { tone: "busy", text: "Working", detail: "1:05 · 2 steps" });

  assert.equal(runLine({ ...state, run: { status: "waiting_for_human", sinceSeq: 4 } }, events, 0).text, "Waiting for you");
  assert.equal(runLine({ ...state, engines: { main: { tool: "claude", online: false, sinceSeq: 1 } as never } }, [], 0).text, "Offline", "a tool that went away is not Ready");
});

test("a run held on your approval is waiting for you, not working", () => {
  const state = project("s", []);
  const held = { ...state, run: { status: "running" as const, sinceSeq: 1 }, approvals: { main: { id: "a", seq: 2, scope: "commands" as const, items: ["rm -rf build"] } } };
  assert.equal(runLine(held, [], 0).text, "Waiting for you");
});

test("two agents of one tool are told apart by number, the first keeping its plain name", async () => {
  const { laneLabel } = await import("../src/client/handoff-ui.js");
  const state = project("s", []);
  const two = { ...state, engines: { main: { tool: "claude", online: true, sinceSeq: 1 } }, lanes: [{ id: "l2", name: "Claude Code" }, { id: "l3", name: "Codex" }] } as never;
  assert.equal(laneLabel(two, "main"), "Claude Code");
  assert.equal(laneLabel(two, "l2"), "Claude Code 2");
  assert.equal(laneLabel(two, "l3"), "Codex");
});

test("in a team the bar names who an agent waits for, and says you only to that person", () => {
  const state = project("s", []);
  const asked = { ...state, run: { status: "running" as const, sinceSeq: 1 }, openQuestions: { main: { to: "sam", toName: "Sam" } } } as never;
  assert.equal(runLine(asked, [], 0, "sam").text, "Waiting for you");
  assert.equal(runLine(asked, [], 0, "maya").text, "Waiting for Sam");
  const approval = { ...state, run: { status: "running" as const, sinceSeq: 1 }, driver: { id: "sam", name: "Sam" }, approvals: { main: { id: "a", seq: 2, scope: "commands", items: [] } } } as never;
  assert.equal(runLine(approval, [], 0, "maya").text, "Waiting for Sam", "an approval waits on the driver");
});

test("the ring is a coding tool's 5-hour limit, never its weekly one", async () => {
  const { fiveHourOf } = await import("../src/client/gauge.js");
  const later = Math.floor(Date.now() / 1000) + 3600;
  const limits = {
    claudeWindows: [
      { kind: "seven_day", utilization: 0.81, resetsAt: later, at: Date.now() },
      { kind: "five_hour", utilization: 0.23, resetsAt: later, at: Date.now() },
    ],
    codexWindows: [
      { kind: "secondary", windowMinutes: 10_080, label: "Weekly", usedPercent: 64, resetsAt: later, at: Date.now() },
      { kind: "primary", windowMinutes: 300, label: "5h", usedPercent: 12, resetsAt: later, at: Date.now() },
    ],
  } as never;
  assert.equal(fiveHourOf("claude", limits)?.used, 23);
  assert.equal(fiveHourOf("codex", limits)?.used, 12);
  assert.equal(fiveHourOf("cursor", limits), null, "a tool without a 5-hour window falls back to its context");
  assert.equal(fiveHourOf(undefined, limits), null);
});

test("with more than one account, the ring is the 5-hour and weekly windows of the account the lane runs on", async () => {
  const { fiveHourOf, weekOf } = await import("../src/client/gauge.js");
  const later = Math.floor(Date.now() / 1000) + 3600;
  const w = (kind: string, windowMinutes: number, usedPercent: number) => ({ kind, windowMinutes, usedPercent, resetsAt: later, at: Date.now() });
  const limits = {
    codex: null,
    claude: null,
    claudeWindows: [],
    accounts: {
      claude: [
        { id: "default", label: "Personal", plan: "Max", windows: [w("five_hour", 300, 40), w("seven_day", 10_080, 70)] },
        { id: "work", label: "Work", plan: "Max", windows: [w("five_hour", 300, 15), w("seven_day", 10_080, 20)] },
      ],
      codex: [{ id: "work", label: "Work", plan: "Pro", windows: [], out: true, outUntil: Date.now() + 3_600_000 }],
    },
  } as never;
  assert.equal(fiveHourOf("claude", limits, "work")?.used, 15, "the Work account's, labelled \"Work · 5h\"");
  assert.equal(weekOf("claude", limits, "work")?.used, 20);
  assert.equal(fiveHourOf("claude", limits)?.used, 40, "no account named: the first, its default");
  assert.equal(fiveHourOf("codex", limits, "work")?.used, 100, "an account out of usage is full until it comes back");
});

test("an account out until a time already past is back, and a window that started over a day or more ago says which day", async () => {
  const { glanceOf } = await import("../src/client/gauge.js");
  const g = glanceOf({
    codex: null,
    claude: null,
    claudeWindows: [{ status: "allowed", kind: "five_hour", utilization: null, resetsAt: Math.floor(Date.now() / 1000) - 2 * 86_400, at: Date.now() }],
    accounts: { codex: [{ id: "work", label: "Work", plan: "Pro", windows: [], out: true, outUntil: Date.now() - 60_000 }] },
  } as never);
  assert.equal(g.codex.rows[0]!.used, null, "not red any more");
  assert.match(g.codex.rows[0]!.text ?? "", /^Back since /);
  const started = g.claude.rows[0]!.text ?? "";
  assert.match(started, /^Started over at /);
  const day = new Date(Date.now() - 2 * 86_400_000).toLocaleString([], { weekday: "short" });
  assert.ok(started.includes(day), `says the day: ${started}`);
});

test("a tooltip's trailing shortcut is set apart; other words are left whole", async () => {
  const { splitTip } = await import("../src/client/Tooltips.js");
  assert.deepEqual(splitTip("Files · Ctrl+2"), { text: "Files", keys: "Ctrl+2" });
  assert.deepEqual(splitTip("History · ⌘⇧H"), { text: "History", keys: "⌘⇧H" });
  assert.deepEqual(splitTip("Claude Code · 5-hour limit 42% used"), { text: "Claude Code · 5-hour limit 42% used", keys: null });
});

test("a tooltip is a name over what it says, with any shortcut set as keys beside the name", async () => {
  const { shapeTip } = await import("../src/client/Tooltips.js");
  assert.deepEqual(shapeTip("Files · Ctrl+2"), { head: "Files", body: [], keys: "Ctrl+2" }, "short: one line");
  assert.deepEqual(shapeTip("Manual: Edits files, and asks you before it runs a command."), { head: "Manual", body: ["Edits files, and asks you before it runs a command."], keys: null }, "a name and its sentence");
  assert.deepEqual(
    shapeTip("Asking you: Should the streak keep counting on days the… · ⌃3 · drag onto the chat to open beside"),
    { head: "Asking you", body: ["Should the streak keep counting on days the…", "Drag onto the chat to open beside"], keys: "⌃3" },
    "a shortcut in the middle comes out as keys, and each part is a line",
  );
  assert.deepEqual(shapeTip("Getting started · ⌃2 · drag onto the chat to open beside"), { head: "Getting started", body: ["Drag onto the chat to open beside"], keys: "⌃2" }, "a long run of parts: the first over the rest");
  assert.deepEqual(
    shapeTip("Codex · Asking you: Should the streak keep counting? · ⌃3 · drag onto the chat to open beside"),
    { head: "Codex", body: ["Asking you: Should the streak keep counting?", "Drag onto the chat to open beside"], keys: "⌃3" },
    "a colon after the first part stays in its line",
  );
  assert.deepEqual(shapeTip("#10 · 10/24/2026, 6:34:08 PM"), { head: "#10 · 10/24/2026, 6:34:08 PM", body: [], keys: null }, "a time's colon is not a name");
  assert.deepEqual(shapeTip("Claude Code · 5-hour limit 42% used"), { head: "Claude Code · 5-hour limit 42% used", body: [], keys: null }, "short enough for one line");
});

test("only the controls a tip helps get one: no words, words cut off, or a shortcut to learn", async () => {
  const { worthATip } = await import("../src/client/Tooltips.js");
  assert.equal(worthATip("", "Open in your browser", false), true, "an icon");
  assert.equal(worthATip("+3", "3 more agents", false), true, "an icon and a count");
  assert.equal(worthATip("Commit on branch", "Commit these changes on the branch", false), false, "says it already");
  assert.equal(worthATip("friday/claude-f55e8…", "friday/claude-f55e8201", true), true, "cut off");
  assert.equal(worthATip("Commands", "Commands · Ctrl+Shift+P", false), true, "a shortcut");
});

// Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes".
test("a question asked in an agent's answer is waiting for you, not Ready", () => {
  const state = project("s", []);
  const asked = { ...state, asks: { main: { seq: 5, questions: [{ question: "Monday or Sunday?", options: [] }] } } } as never;
  assert.equal(runLine(asked, [], 0).text, "Waiting for you");
});

test("out of usage or signed out, with its work carried on by another agent, the bar isn't Stopped", async () => {
  const { carriedOn } = await import("../src/limit-reset.js");
  const at = (seq: number, body: SessionEvent["body"], lane?: string): SessionEvent => ({ seq, ts: seq, actor: { id: "a", name: "A", kind: "agent" }, body, ...(lane ? { lane } : {}) }) as SessionEvent;
  const lane = { type: "lane.added", lane: { id: "codex", name: "Codex", agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } } as SessionEvent["body"];
  const base = [at(1, lane), at(2, { type: "run.started", causedBy: 0 }), at(3, { type: "run.ended", outcome: "error", error: "5-hour limit reached ∙ resets 3pm" })];
  const alone = project("s", base);
  assert.equal(runLine(alone, [], 0).text, "Stopped", "nobody has its work yet");
  const carried = project("s", [...base, at(4, { type: "run.started", causedBy: 0 }, "codex"), at(5, { type: "run.ended", outcome: "done" }, "codex")]);
  assert.ok(carriedOn(carried, "main"));
  assert.equal(runLine(carried, [], 0).text, "Ready", "Codex finished it");
  const out = project("s", [base[0]!, base[1]!, at(3, { type: "run.ended", outcome: "error", error: "Claude Code isn't signed in on the computer it runs on." }), at(4, { type: "run.started", causedBy: 0 }, "codex")]);
  assert.ok(carriedOn(out, "main"), "signed out, Codex on it");
  const agent = (lane: string, status: string, name: string) => ({ lane, name, status, line: "" }) as never;
  assert.equal(barLine({ tone: "idle", text: "Ready" }, [agent("main", "limited", "Claude Code"), agent("codex", "done", "Codex")]).text, "Ready");
  assert.equal(barLine({ tone: "idle", text: "Ready" }, [agent("main", "failed", "Claude Code"), agent("codex", "done", "Codex")], (l) => l === "main").text, "Ready");
  assert.equal(barLine({ tone: "idle", text: "Ready" }, [agent("main", "failed", "Claude Code"), agent("codex", "done", "Codex")]).text, "Claude Code stopped");
});
