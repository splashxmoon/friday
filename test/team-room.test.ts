// Crew: what the Team room makes of the log (2026-10-27 audit).
import assert from "node:assert/strict";
import test from "node:test";
import { group } from "../src/client/Activity.js";
import { blockFor, isFridayNote, isLive, isPersonsWord, isWaiting, leadAnswers, queuedFor, roomRunKind, switchedAfter, turnsFor, type LeadInfo, type RunLike } from "../src/client/team-room.js";
import type { SessionEvent } from "../src/types.js";

let seq = 0;
const ev = (lane: string, actor: { id: string; name: string; kind: string }, body: Record<string, unknown>) => ({ seq: ++seq, ts: seq * 1000, lane, actor, body }) as unknown as SessionEvent;
const me = { id: "u", name: "Arun", kind: "human" };
const friday = { id: "system", name: "Friday", kind: "system" };
const kit = { id: "agent", name: "Kit", kind: "agent" };
const nova = { id: "agent", name: "Nova", kind: "agent" };
const say = (lane: string, text: string, more: Record<string, unknown> = {}) => ev(lane, me, { type: "instruction", text, interrupt: false, ...more });
const msg = (lane: string, who: typeof kit, text: string) => ev(lane, who, { type: "agent.message", text, toolCalls: [] });
const task = (to: string, text: string) => ev(to, nova, { type: "instruction", text, interrupt: false, mesh: { id: `m${seq}`, kind: "task", fromLane: "n", fromName: "Nova", toName: "Kit", hop: 1, by: null } });
const runsOf = (events: SessionEvent[]) => group(events, new Set()).filter((i): i is Extract<ReturnType<typeof group>[number], { kind: "run" }> => i.kind === "run") as unknown as RunLike[];
const kindOf = (it: RunLike, events: SessionEvent[], status: string, lead: string | null = null, answers = new Set<number>()) => {
  const runs = runsOf(events).filter((r) => r.lane === it.lane);
  return roomRunKind(it, { room: true, now: { lastKey: runs.at(-1)?.key, status }, turns: turnsFor(events), lead, leadAnswers: answers });
};

test("a teammate's answers from turns long finished stay in the room while it works again; only its turn under way is the working line", () => {
  const a1 = say("k", "Build the pricing page");
  const r1 = ev("k", kit, { type: "run.started", causedBy: a1.seq });
  const d1 = ev("k", kit, { type: "instructions.delivered", seqs: [a1.seq] });
  const first = msg("k", kit, "Built the pricing page: three plans.");
  // The person writes while it works: the block is cut there, and the turn carries on in a second block.
  const a2 = say("k", "Add a yearly toggle too");
  const second = msg("k", kit, "Added the yearly toggle.");
  const e1 = ev("k", kit, { type: "run.ended", outcome: "done" });
  const a3 = say("k", "Now the FAQ");
  const r2 = ev("k", kit, { type: "run.started", causedBy: a3.seq });
  const d2 = ev("k", kit, { type: "instructions.delivered", seqs: [a3.seq] });
  const now = msg("k", kit, "Reading the FAQ copy.");
  const events = [a1, r1, d1, first, a2, second, e1, a3, r2, d2, now];
  const [cut, ended, live] = runsOf(events);
  assert.deepEqual([cut!.ended, !!ended!.ended, live!.ended], [null, true, null], "the first block was cut short, never ended");
  assert.equal(kindOf(cut!, events, "running"), "show", "a cut-short block of a finished turn stays while the lane works");
  assert.equal(kindOf(ended!, events, "running"), "show");
  assert.equal(kindOf(live!, events, "running"), "hide", "the turn under way is the working line over the box");
  const lastKey = live!.key;
  assert.ok(!isLive(cut!, { lastKey, status: "running" }));
  assert.ok(isLive(live!, { lastKey, status: "running" }));
  // TeamRun's "needs you" is the newest block's only: an older cut-short block isn't waiting.
  assert.ok(!isWaiting(cut!, { lastKey, status: "waiting_for_human" }));
  assert.ok(isWaiting(live!, { lastKey, status: "waiting_for_human" }));
});

test("a teammate busy on the lead's work and handed the person's message answers them: that answer shows, the rest folds", () => {
  const t1 = task("k", "Do the landing page");
  const r1 = ev("k", kit, { type: "run.started", causedBy: t1.seq });
  const d1 = ev("k", kit, { type: "instructions.delivered", seqs: [t1.seq] });
  const m1 = msg("k", kit, "Working on the hero");
  const ask = say("k", "@Kit what's the status?");
  const m2 = msg("k", kit, "Hero done.");
  const d2 = ev("k", kit, { type: "instructions.delivered", seqs: [ask.seq] });
  const m3 = msg("k", kit, "Status: hero done, pricing next.");
  const e1 = ev("k", kit, { type: "run.ended", outcome: "done" });
  const events = [t1, r1, d1, m1, ask, m2, d2, m3, e1];
  const turns = turnsFor(events);
  assert.deepEqual([turns.get(m1.seq), turns.get(m2.seq), turns.get(m3.seq)], ["team", "team", "person"]);
  const [onTask, answer] = runsOf(events);
  assert.equal(blockFor(answer!, turns), "person");
  assert.equal(kindOf(onTask!, events, "idle"), "talk", "its turn on the lead's work folds with the talk");
  assert.equal(kindOf(answer!, events, "idle"), "show", "the block with its answer to the person shows");
});

test("whom a turn answers: Friday's notes and a yes carry on what came before, a check-in is a routine's, a hand-off carries its lane's", () => {
  // Friday's carry on, sent as the owner (older logs) or as Friday: the turn goes on answering the person.
  const ask = say("j", "Write up what T3 Code shipped");
  const r1 = ev("j", kit, { type: "run.started", causedBy: ask.seq });
  const m1 = msg("j", kit, "Read the changelog.");
  const e1 = ev("j", kit, { type: "run.ended", outcome: "error", error: "Claude AI usage limit reached|1760000000" });
  const carry = say("j", "[Friday] Claude Code ran out of usage partway through your work, so you are on Codex now.");
  const r2 = ev("j", kit, { type: "run.started", causedBy: carry.seq });
  const m2 = msg("j", kit, "The write-up is in t3.md.");
  const e2 = ev("j", kit, { type: "run.ended", outcome: "done" });
  const nudge = ev("j", friday, { type: "instruction", text: "Your turn ended short of its task: carry on.", interrupt: false, keepGoing: true });
  const r3 = ev("j", kit, { type: "run.started", causedBy: nudge.seq });
  const m3 = msg("j", kit, "Added the pricing table.");
  const e3 = ev("j", kit, { type: "run.ended", outcome: "done" });
  // A hand-off from that lane to another carries on whom it was working for; one from a lane on the team's work, the team's.
  const off = ev("x", kit, { type: "instruction", text: "Finish the write-up", interrupt: false, handoff: { fromLane: "j", fromName: "Juno", toName: "Pip", reason: "out of usage", carried: [] } });
  const r5 = ev("x", nova, { type: "run.started", causedBy: off.seq });
  const m5 = msg("x", nova, "Finished it.");
  // A check-in the person set, from the owner: a routine's turn, not the person speaking.
  const check = say("j", "[Check-in] Anything new from T3?\n\n(Your daily check-in, set by the person.)");
  const r4 = ev("j", kit, { type: "run.started", causedBy: check.seq });
  const m4 = msg("j", kit, "Nothing big today.");
  const e4 = ev("j", kit, { type: "run.ended", outcome: "done" });
  const t1 = task("k", "Do the landing page");
  const r6 = ev("k", kit, { type: "run.started", causedBy: t1.seq });
  const m6 = msg("k", kit, "On it.");
  const e6 = ev("k", kit, { type: "run.ended", outcome: "done" });
  const off2 = ev("y", kit, { type: "instruction", text: "Take the landing page", interrupt: false, handoff: { fromLane: "k", fromName: "Kit", toName: "Pip", reason: "busy", carried: [] } });
  const r7 = ev("y", nova, { type: "run.started", causedBy: off2.seq });
  const m7 = msg("y", nova, "Took it.");
  const events = [ask, r1, m1, e1, carry, r2, m2, e2, nudge, r3, m3, e3, off, r5, m5, check, r4, m4, e4, t1, r6, m6, e6, off2, r7, m7];
  const turns = turnsFor(events);
  assert.deepEqual(
    [m1, m2, m3, m5, m4, m6, m7].map((m) => turns.get(m.seq)),
    ["person", "person", "person", "person", "routine", "team", "team"],
  );
  assert.ok(isPersonsWord(ask));
  for (const e of [carry, nudge, check, off]) assert.ok(!isPersonsWord(e), "none of these is the person speaking");
});

test("a message the person sent to busy teammates stays in the room, saying whom it still waits for", () => {
  const pending: Record<string, number[]> = { k: [10], j: [11] };
  const names: Record<string, string> = { k: "Kit", j: "Juno" };
  const copies = [
    { lane: "k", seq: 10 },
    { lane: "j", seq: 11 },
  ];
  assert.deepEqual(queuedFor(copies, (l) => pending[l] ?? [], (l) => names[l] ?? ""), ["Kit", "Juno"], "a merged send, both copies queued");
  pending.k = [];
  assert.deepEqual(queuedFor(copies, (l) => pending[l] ?? [], (l) => names[l] ?? ""), ["Juno"], "Kit picked its copy up; Juno's still waits");
  pending.j = [];
  assert.deepEqual(queuedFor(copies, (l) => pending[l] ?? [], (l) => names[l] ?? ""), []);
});

test("a teammate that needs the person says so in the room, never \"is working\", and isn't the working line", () => {
  const ask = say("k", "Ship the FAQ");
  const r1 = ev("k", kit, { type: "run.started", causedBy: ask.seq });
  const m1 = msg("k", kit, "Which domain should the FAQ go on?");
  const events = [ask, r1, m1];
  const [run] = runsOf(events);
  const now = { lastKey: run!.key, status: "waiting_for_human" };
  assert.ok(!isLive(run!, now), "waiting isn't working: TeamRun's active is false");
  assert.ok(isWaiting(run!, now), "and its outcome is \"waiting\": it needs you");
  assert.equal(kindOf(run!, events, "waiting_for_human"), "show");
  // A teammate waiting on the person in a turn on the lead's work still shows: what needs the person is never folded away.
  const t1 = task("n2", "Do the hero");
  const r2 = ev("n2", kit, { type: "run.started", causedBy: t1.seq });
  const m2 = msg("n2", kit, "Should the hero have a video?");
  const [run2] = runsOf([t1, r2, m2]);
  assert.equal(kindOf(run2!, [t1, r2, m2], "waiting_for_human"), "show");
});

test("Friday's notes, from Friday or in the owner's name, stay out of the room and never count as the person; hand-offs show", async () => {
  const { teamEventKind } = await import("../src/client/Teammates.js");
  const asOwner = say("j", "[Friday] Claude Code ran out of usage partway through your work, so you are on Codex now.");
  const asFriday = ev("j", friday, { type: "instruction", text: "[Friday] Claude Code ran out of usage partway through your work.", interrupt: false });
  const nudge = say("j", "Carry on: your task isn't finished.", { keepGoing: true });
  const off = ev("x", kit, { type: "instruction", text: "Finish the write-up", interrupt: false, handoff: { fromLane: "j", fromName: "Juno", toName: "Pip", reason: "out of usage", carried: [] } });
  const check = say("j", "[Check-in] Anything new?");
  const t1 = task("k", "Do the landing page");
  for (const e of [asOwner, asFriday, nudge]) {
    assert.ok(isFridayNote(e));
    assert.ok(!isPersonsWord(e));
    assert.equal(teamEventKind(e, true), "hide", "out of the room");
  }
  for (const e of [off, check, t1, say("j", "Write it up")]) assert.ok(!isFridayNote(e));
  assert.equal(teamEventKind(off, true), "show", "a hand-off is shown, not taken for Friday's note");
  // The lead's answer is its last turn before the person next speaks: Friday's note in between isn't the person speaking.
  const info = (x: LeadInfo) => x;
  const answers = leadAnswers([info({ kind: "lead", key: 1, text: "Done: the plan is in plan.md." }), info(isPersonsWord(asOwner) ? { kind: "person" } : { kind: "skip" }), info({ kind: "lead", key: 2, text: "Noted." })], (x) => x);
  assert.deepEqual([...answers], [2], "only the last, as Friday's note didn't open a new stretch");
});

test("one row per switch to a backup tool: the switch's line, not the run's header too", () => {
  const ask = say("j", "Write up what T3 Code shipped");
  const r1 = ev("j", kit, { type: "run.started", causedBy: ask.seq });
  const e1 = ev("j", kit, { type: "run.ended", outcome: "error", error: "Claude AI usage limit reached|1760000000" });
  const sw = ev("main", friday, { type: "teammate.switched", name: "Juno", lane: "j", from: "claude", to: "codex", until: null });
  const r2 = ev("j", kit, { type: "run.started", causedBy: ask.seq });
  assert.ok(switchedAfter([ask, r1, e1, sw, r2], "j", e1.seq));
  assert.ok(!switchedAfter([ask, r1, e1, r2, sw], "j", e1.seq), "a switch after the lane's next turn is that turn's");
  assert.ok(!switchedAfter([ask, r1, e1, sw], "k", e1.seq), "another lane's");
  // A run that said nothing before it ran out is left out: the switch's line says it all.
  const silent: RunLike = { lane: "j", key: 100, messages: [], diffs: [], ended: { seq: e1.seq, body: { outcome: "error", error: "Claude AI usage limit reached|1760000000" } } };
  const opts = { room: true, now: { lastKey: 100, status: "idle" }, turns: new Map(), lead: null, leadAnswers: new Set<number>() };
  assert.equal(roomRunKind(silent, { ...opts, switched: true }), "hide");
  assert.equal(roomRunKind({ ...silent, messages: [{ seq: 99, body: { text: "Read the changelog." } }] }, { ...opts, switched: true }), "show", "what it said still shows");
});

test("the lead's answer, once shown, isn't folded away by a short turn after it; a substantial turn ending a stretch stays too", () => {
  const long = "Every task is done: the landing page is live, the FAQ is in, the pricing page has the yearly toggle, and the tests pass.";
  const items: LeadInfo[] = [
    { kind: "person" },
    { kind: "lead", key: 1, text: "Posted three tasks to the board." },
    { kind: "other" },
    { kind: "lead", key: 2, text: long },
    { kind: "other" },
    { kind: "lead", key: 3, text: "Noted: Kit's late report changes nothing." },
  ];
  assert.deepEqual([...leadAnswers(items, (x) => x)].sort(), [2, 3], "the summary and the last word; the short plan ahead of the work folds");
  assert.deepEqual([...leadAnswers([...items, { kind: "person" } as LeadInfo], (x) => x)].sort(), [2, 3], "the person speaking next changes nothing");
});

test("how a teammate stands in one team chat is from that chat's own runs, not from every room it is in", async () => {
  const { noteLaneRuns, statusIn, statusLineIn } = await import("../src/client/Teammates.js");
  const juno = { id: "t-juno", name: "Juno", lane: "j", status: "working", line: "Writing the launch FAQ", queued: 0 } as unknown as Parameters<typeof statusIn>[2];
  noteLaneRuns("team-sid", { k: { status: "running" }, j: { status: "idle" } });
  assert.equal(statusIn("team-sid", "j", juno), "idle", "Juno works in Launch week, not in the Team room");
  assert.equal(statusIn("team-sid", "k", { ...juno, lane: "k" }), "working");
  assert.match(statusLineIn("team-sid", "j", juno), /^Idle here · working /);
  noteLaneRuns("team-sid", { j: { status: "waiting_for_human" } });
  assert.equal(statusIn("team-sid", "j", juno), "waiting");
  assert.equal(statusIn("team-sid", "j", { ...juno, status: "offline" }), "offline", "offline is its own, wherever it is");
  assert.equal(statusIn("never-drawn", "j", juno), "working", "a chat not drawn yet: as it stands anywhere");
});

test("a room's last words on its card are plain text that keeps underscores and stars inside words and code", async () => {
  const { plainLine } = await import("../src/client/team-room.js");
  assert.equal(
    plainLine("Built it with:\n\n```sh\nnpx run_check_ins --dir\n```\n\n**Relevant** lines: `my_var` and _this_ and __that__ and snake_case_name."),
    "Built it with: npx run_check_ins --dir Relevant lines: my_var and this and that and snake_case_name.",
  );
  assert.equal(plainLine("## Plan\n> quoted\n- one\n- two *em*\n\n| Day | Post |\n| --- | --- |\n| Mon | Thread |"), "Plan quoted one two em Day, Post; Mon, Thread;");
  assert.equal(plainLine("See [the docs](http://x.y/a_b) and 2*3*4"), "See the docs and 2*3*4");
});

test("a new teammate's look is in a colour none of the team has, while one is free", async () => {
  const { distinctLook, teamColour, TEAM_COLOURS } = await import("../src/client/teammate-block.js");
  const team = ["Nova", "Kit", "Juno"];
  const look = distinctLook("Pip", team);
  assert.ok(!team.map(teamColour).includes(teamColour(look)), `${look} in a colour of its own`);
  // Its own name is kept when its colour is free.
  const free = TEAM_COLOURS.length > 3 ? ["Rio", "Ash", "Bo", "Cy", "Di"].find((n) => !team.map(teamColour).includes(teamColour(n))) : undefined;
  if (free) assert.equal(distinctLook(free, team), free);
  // Every colour taken: as it is.
  const all = Array.from({ length: 200 }, (_, i) => `m${i}`);
  assert.equal(distinctLook("Pip", all), "Pip");
});

test("in a team, the Agents panel leaves out Friday Code; a teammate out of usage says until when", async () => {
  const { teamHubAgents, statusLine } = await import("../src/client/Teammates.js");
  const agents = [
    { lane: "main", status: "ready", line: "Ready for a task", tool: null },
    { lane: "k", status: "working", line: "Using Bash", tool: "codex" as const },
  ];
  assert.deepEqual(teamHubAgents({ engines: { k: { tool: "codex" } } }, agents).map((a) => a.lane), ["k"]);
  const nova = { id: "n", name: "Nova", lane: "n", tool: "claude", status: "limited", line: "Out of usage until 10:42 PM · same account as Juno", queued: 0 } as unknown as Parameters<typeof statusLine>[0];
  // The time first, then who covers (team-status.ts sayMate; Arun, 2026-10-28: the critique's "Out until 12:38 · Codex covers").
  assert.equal(statusLine(nova), "Out until 10:42 PM · Codex covers");
});
