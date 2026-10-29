import assert from "node:assert/strict";
import { test } from "node:test";
import { foldNotes, groupForTest as group } from "../src/client/Activity.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/**
 * What a run looks like in the feed while it is happening.
 *
 * A diff arrives after every write the agent makes, so showing each one turned
 * a run into a flicker of half-finished change sets: one file, then that file
 * with three more lines, then a fourth file. None of those were worth reading
 * and the one that was got lost among them. The diff is the answer to "what
 * did it do", and that is only answerable once it has stopped doing it.
 */

const ev = (seq: number, body: EventBody): SessionEvent =>
  ({ seq, ts: seq, actor: { id: "agent", name: "Agent", kind: "agent" }, body }) as SessionEvent;
const diff = (...paths: string[]): EventBody => ({
  type: "agent.diff",
  base: "abc123",
  files: paths.map((path) => ({ path, status: "modified", additions: 1, deletions: 0, patch: "" })),
});
const msg = (): EventBody => ({ type: "agent.message", text: "", toolCalls: [] });

test("every diff belongs to its run, and the run holds the newest one", () => {
  const items = group([ev(1, msg()), ev(2, diff("a.ts")), ev(3, diff("a.ts", "b.ts"))], false);
  assert.equal(items.length, 1, "the diffs don't split the run into pieces");
  const run = items[0] as Extract<(typeof items)[number], { kind: "run" }>;
  assert.equal(run.diffs.length, 2);
  assert.deepEqual(run.diffs.at(-1)!.body.files.map((f) => f.path), ["a.ts", "b.ts"], "the last one is what gets drawn");
  assert.equal(run.ended, null, "and while it is null, nothing is drawn at all");
});

test("a diff arriving just after the run ended still belongs to that run", () => {
  // The machine reports changes on a short debounce, so the last one often
  // lands after the turn is over. A loose card floating under the run would be
  // the same diff, twice, in two places.
  const items = group([ev(1, msg()), ev(2, diff("a.ts")), ev(3, { type: "run.ended", outcome: "done" }), ev(4, diff("a.ts", "b.ts"))], false);
  assert.equal(items.length, 1, "no loose diff card after the run");
  const run = items[0] as Extract<(typeof items)[number], { kind: "run" }>;
  assert.ok(run.ended, "the run is finished, so its diff is now worth showing");
  assert.deepEqual(run.diffs.at(-1)!.body.files.map((f) => f.path), ["a.ts", "b.ts"]);
});

test("a new run doesn't inherit the last one's changes", () => {
  const items = group([ev(1, msg()), ev(2, { type: "run.ended", outcome: "done" }), ev(3, msg()), ev(4, diff("c.ts"))], false);
  const runs = items.filter((i) => i.kind === "run") as Extract<(typeof items)[number], { kind: "run" }>[];
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.diffs.length, 0);
  assert.equal(runs[1]!.diffs.length, 1);
});

test("anything the team does in between ends the run's claim on later diffs", () => {
  const items = group(
    [ev(1, msg()), ev(2, { type: "run.ended", outcome: "done" }), ev(3, { type: "instruction", text: "again", interrupt: false }), ev(4, diff("d.ts"))],
    false,
  );
  const runs = items.filter((i) => i.kind === "run") as Extract<(typeof items)[number], { kind: "run" }>[];
  assert.equal(runs[0]!.diffs.length, 0, "that diff came after somebody spoke, so it is its own card");
  assert.ok(items.some((i) => i.kind === "event" && i.ev.body.type === "agent.diff"));
});

/**
 * Two agents working at once. Their steps arrive interleaved in one log, and the feed has to keep each
 * agent's work together under its own name. Folded into one column, the second agent's steps joined the
 * first agent's block, so one agent appeared to be doing both jobs.
 */
const inLane = (lane: string, seq: number, body: EventBody): SessionEvent => ({ ...ev(seq, body), lane }) as SessionEvent;
type Run = Extract<ReturnType<typeof group>[number], { kind: "run" }>;

test("two agents' interleaved steps stay in two blocks, each in its own lane", () => {
  const items = group([ev(1, msg()), inLane("seo", 2, msg()), ev(3, msg()), inLane("seo", 4, msg())], false);
  const runs = items.filter((i): i is Run => i.kind === "run");
  assert.equal(runs.length, 2, "one block per agent, not one block for both");
  const main = runs.find((r) => r.lane === "main")!;
  const seo = runs.find((r) => r.lane === "seo")!;
  assert.deepEqual(main.messages.map((m) => m.seq), [1, 3]);
  assert.deepEqual(seo.messages.map((m) => m.seq), [2, 4]);
});

test("one agent finishing does not end the other's block", () => {
  const items = group([ev(1, msg()), inLane("seo", 2, msg()), inLane("seo", 3, { type: "run.ended", outcome: "done" }), ev(4, msg())], false);
  const runs = items.filter((i): i is Run => i.kind === "run");
  assert.equal(runs.length, 2);
  assert.equal(runs.find((r) => r.lane === "seo")!.ended?.seq, 3);
  assert.equal(runs.find((r) => r.lane === "main")!.ended, null, "main is still going");
  assert.deepEqual(runs.find((r) => r.lane === "main")!.messages.map((m) => m.seq), [1, 4], "and its steps stayed together");
});

test("a message to one agent closes that agent's block and leaves the other's alone", () => {
  const told: SessionEvent = { ...ev(3, { type: "instruction", text: "carry on", attachments: [] } as unknown as EventBody), lane: "seo" } as SessionEvent;
  const items = group([ev(1, msg()), inLane("seo", 2, msg()), told, ev(4, msg()), inLane("seo", 5, msg())], false);
  const runs = items.filter((i): i is Run => i.kind === "run");
  assert.equal(runs.filter((r) => r.lane === "seo").length, 2, "the team spoke to seo, so its next steps open a new block");
  assert.equal(runs.filter((r) => r.lane === "main").length, 1, "main was not spoken to and keeps one block");
});

test("each working agent gets its own live block", () => {
  const items = group([], new Set(["main", "seo"]));
  const runs = items.filter((i): i is Run => i.kind === "run");
  assert.deepEqual(runs.map((r) => r.lane).sort(), ["main", "seo"]);
  assert.ok(runs.every((r) => r.streaming));
  assert.equal(new Set(runs.map((r) => r.key)).size, 2, "and they do not share a key");
});

test("three agents interleaved stay in three blocks, in the order each began", () => {
  const items = group([ev(1, msg()), inLane("a", 2, msg()), inLane("b", 3, msg()), ev(4, msg()), inLane("b", 5, msg()), inLane("a", 6, msg())], false);
  const runs = items.filter((i): i is Run => i.kind === "run");
  assert.deepEqual(runs.map((r) => r.lane), ["main", "a", "b"], "ordered by when each agent first spoke");
  assert.deepEqual(runs.map((r) => r.messages.map((m) => m.seq)), [[1, 4], [2, 6], [3, 5]]);
});

test("a diff goes to the agent that made it, even with another agent's steps in between", () => {
  const items = group([ev(1, msg()), inLane("a", 2, msg()), inLane("a", 3, diff("a.ts")), ev(4, diff("main.ts")), inLane("a", 5, { type: "run.ended", outcome: "done" }), inLane("a", 6, diff("a.ts", "more.ts"))], false);
  const runs = items.filter((i): i is Run => i.kind === "run");
  const main = runs.find((r) => r.lane === "main")!;
  const a = runs.find((r) => r.lane === "a")!;
  assert.deepEqual(main.diffs.map((d) => d.body.files.map((f) => f.path)), [["main.ts"]]);
  assert.deepEqual(a.diffs.map((d) => d.body.files.map((f) => f.path)), [["a.ts"], ["a.ts", "more.ts"]], "including the one that landed after its run ended");
});

test("each agent's run keeps the checkpoint taken when that run started", () => {
  const started = (lane: string | undefined, seq: number, sha: string): SessionEvent => ({ ...ev(seq, { type: "run.started", causedBy: 0, checkpoint: sha } as EventBody), ...(lane ? { lane } : {}) }) as SessionEvent;
  const items = group([started(undefined, 1, "a".repeat(40)), started("b", 2, "b".repeat(40)), ev(3, msg()), inLane("b", 4, msg())], false);
  const runs = items.filter((i): i is Run => i.kind === "run");
  assert.equal(runs.find((r) => r.lane === "main")!.checkpoint?.sha, "a".repeat(40));
  assert.equal(runs.find((r) => r.lane === "b")!.checkpoint?.sha, "b".repeat(40));
  assert.equal(runs.find((r) => r.lane === "b")!.checkpoint?.lane, "b");
});

test("an error from an agent that produced nothing is its own row, in its own lane", () => {
  const items = group([ev(1, msg()), inLane("a", 2, { type: "run.ended", outcome: "error", error: "model account problem" })], false);
  const err = items.find((i) => i.kind === "event");
  assert.ok(err && err.kind === "event" && err.ev.lane === "a");
  assert.equal(items.filter((i) => i.kind === "run").length, 1, "main's block is untouched");
});

test("a single agent's feed is exactly what it always was", () => {
  const items = group([ev(1, msg()), ev(2, diff("a.ts")), ev(3, { type: "run.ended", outcome: "done" }), ev(4, msg())], false);
  const runs = items.filter((i): i is Run => i.kind === "run");
  assert.equal(runs.length, 2, "a finished run and the next one");
  assert.equal(runs[0]!.lane, "main");
});

test("a request for permission stays with its run, so the run's end and its review card land on it", () => {
  // Manual mode: the turn stops to ask, then ends. The request used to close the block, the end then had nowhere to land,
  // and the changes the run made had no review card: nothing to accept, nothing to undo.
  const items = group([ev(1, msg()), ev(2, diff("a.ts")), ev(3, { type: "engine.approval", id: "k", scope: "commands", items: ["npm test"] }), ev(4, { type: "run.ended", outcome: "done" })], false);
  assert.deepEqual(items.map((i) => i.kind), ["run", "event"], "the block, then the request under it");
  const run = items[0] as Extract<(typeof items)[number], { kind: "run" }>;
  assert.equal(run.ended?.seq, 4, "the run's end is on its block");
  assert.equal(run.diffs.length, 1, "with the diff it made");
});

test("a block closed by something the team did ends when it was closed, not now, and says by what", () => {
  // Its "Worked for" used to count on to the moment the page was loaded, so 44 seconds of work read as minutes after a reload.
  const items = group([ev(1, msg()), ev(5, { type: "control.granted", to: "u-bea", toName: "Bea", reason: "yield" })], false);
  const run = items[0] as Extract<(typeof items)[number], { kind: "run" }>;
  assert.equal(run.closedTs, 5);
  assert.equal(run.closedBy, "control.granted", "so it is not called paused while the run goes on");
});

test("session notes are folded one agent at a time, so Claude Code connecting after Codex isn't listed under Codex", () => {
  const note = (seq: number, lane: string, body: EventBody) => ({ kind: "event" as const, ev: { ...ev(seq, body), lane } });
  const took: EventBody = { type: "control.granted", to: "u", toName: "Arun", reason: "claim" };
  const attached = { type: "engine.attached", engine: {} } as unknown as EventBody;
  const items = foldNotes([note(1, "codex", took), note(2, "codex", attached), note(3, "claude", took), note(4, "claude", attached)]);
  assert.deepEqual(
    items.map((i) => (i.kind === "notes" ? i.evs.map((e) => `${e.lane}:${e.seq}`) : i.kind)),
    [["codex:1", "codex:2"], ["claude:3", "claude:4"]],
  );
});

test("a yes given while the run waits on it doesn't split the run in two", () => {
  const items = group(
    [
      ev(1, msg()),
      ev(2, { type: "engine.approval", id: "q1", scope: "commands", items: ["npm test"], live: true }),
      { ...ev(3, { type: "instruction", text: "Yes, run it.", interrupt: false, approval: { id: "q1", approve: true } }), actor: { id: "u", name: "Ada", kind: "human" } } as SessionEvent,
      ev(4, { type: "agent.message", text: "42", toolCalls: [] }),
    ],
    true,
  );
  const runs = items.filter((i) => i.kind === "run");
  assert.equal(runs.length, 1, "one block, before and after the answer");
  assert.equal((runs[0] as Extract<(typeof items)[number], { kind: "run" }>).messages.length, 2);
});

test("a turn carried on without a start of its own is about the last ask, and a later run that changed nothing is not credited", () => {
  // From a live session: SLOW asked, paused, resumed with Friday's own carry-on, which changed README; then a run that failed at
  // sign-in reported the same change set and read "Because Arun asked: SIGNOUT…", for edits it never made.
  const you = (seq: number, text: string): SessionEvent => ({ seq, ts: seq, actor: { id: "a", name: "Arun", kind: "human" }, body: { type: "instruction", text, interrupt: false } }) as SessionEvent;
  const readme: EventBody = { type: "agent.diff", base: "abc123", files: [{ path: "README.md", status: "modified", additions: 2, deletions: 0, patch: "+x" }] };
  const items = group(
    [
      you(1, "SLOW work through the long refactor"),
      ev(2, { type: "run.started", causedBy: 1 } as EventBody),
      ev(3, msg()),
      ev(4, { type: "run.pause" } as EventBody),
      ev(5, { type: "run.resume" } as EventBody),
      you(6, "[session] Carry on where you left off."),
      ev(7, msg()),
      ev(8, readme),
      ev(9, { type: "run.ended", outcome: "done" }),
      you(10, "SIGNOUT tidy the imports"),
      ev(11, { type: "run.started", causedBy: 10 } as EventBody),
      ev(12, msg()),
      ev(13, readme),
      ev(14, { type: "run.ended", outcome: "error", error: "not signed in" }),
    ],
    false,
  );
  const runs = items.filter((i) => i.kind === "run") as Extract<(typeof items)[number], { kind: "run" }>[];
  assert.equal(runs[1]!.ask?.text, "SLOW work through the long refactor", "the resumed turn is still about what was asked, not Friday's carry-on");
  assert.equal(runs[2]!.unchanged, true);
  assert.equal(runs[2]!.ask?.text, "SLOW work through the long refactor", "credited to the ask that made the changes");
});

test("a run that changed some files says which of the set were already waiting from earlier", async () => {
  const { explainRun } = await import("../src/explain.js");
  const file = (path: string, patch: string) => ({ path, status: "modified" as const, additions: 1, deletions: 0, patch });
  const items = group(
    [
      ev(1, msg()),
      ev(2, { type: "agent.diff", base: "b", files: [file("README.md", "+notes")] }),
      ev(3, { type: "run.ended", outcome: "done" }),
      ev(4, { type: "instruction", text: "tighten the auth", interrupt: false } as EventBody),
      ev(5, msg()),
      ev(6, { type: "agent.diff", base: "b", files: [file("README.md", "+notes"), file("src/auth.ts", "+check")] }),
      ev(7, { type: "run.ended", outcome: "done" }),
    ],
    false,
  );
  const runs = items.filter((i) => i.kind === "run") as Extract<(typeof items)[number], { kind: "run" }>[];
  assert.deepEqual(runs[1]!.earlier, ["README.md"]);
  assert.equal(runs[1]!.unchanged, undefined);
  const said = explainRun({ files: runs[1]!.diffs.at(-1)!.body.files, earlier: runs[1]!.earlier, ask: { who: "Arun", text: "tighten the auth" } });
  assert.equal(said[1], "README.md was already waiting from earlier.", "said before the ask, so the ask isn't read as covering it");
});

test("a message queued mid-run leaves the rest of the run its ask and its undo", () => {
  const you = (seq: number, text: string): SessionEvent => ({ seq, ts: seq, actor: { id: "a", name: "Arun", kind: "human" }, body: { type: "instruction", text, interrupt: false } }) as SessionEvent;
  const items = group(
    [
      you(1, "fix the cart total"),
      ev(2, { type: "run.started", causedBy: 1, checkpoint: "c0ffee" } as EventBody),
      ev(3, msg()),
      you(4, "also add a test"),
      ev(5, msg()),
      ev(6, diff("cart.ts")),
      ev(7, { type: "run.ended", outcome: "done" }),
    ],
    false,
  );
  const runs = items.filter((i) => i.kind === "run") as Extract<(typeof items)[number], { kind: "run" }>[];
  assert.equal(runs.length, 2, "the queued message still sits where it was sent");
  assert.equal(runs[1]!.ask?.text, "fix the cart total", "not the message that was only queued");
  assert.deepEqual(runs[1]!.checkpoint, { sha: "c0ffee", lane: "main", at: 3 }, "undo goes back to before the run, and rewinds from its first step");
});

/**
 * A coding tool reports its folder each time it comes back (a deploy, a drop, the app restarting), and each runner measures it
 * from where it stands, so two reports can differ and never dedupe as "the same set": a session that had been through a few
 * deploys read as a column of "Changed 80 files" cards with nothing between them (Arun, 2026-10-25). With nothing of the lane's
 * since the last loose card, the newest report takes its place; other lanes' reports in between don't keep it.
 */
test("a loose change set said again takes the earlier card's place, per lane", () => {
  const lane = (seq: number, body: EventBody, l: string): SessionEvent => ({ ...ev(seq, body), lane: l }) as SessionEvent;
  const items = group(
    [
      ev(1, { type: "instruction", text: "go", interrupt: false }),
      ev(2, diff("a.ts")),
      lane(3, diff("b.ts"), "l1"),
      ev(4, diff("a.ts", "c.ts")),
      lane(5, diff("b.ts", "d.ts"), "l1"),
      ev(6, diff("a.ts")),
    ],
    false,
  );
  const loose = items.filter((i) => i.kind === "event" && i.ev.body.type === "agent.diff") as Extract<(typeof items)[number], { kind: "event" }>[];
  assert.deepEqual(loose.map((i) => i.ev.seq), [6, 5], "one card per lane, the newest report each");
  // Something of the lane's in between (a run) keeps the card before it as history.
  const after = group([ev(1, diff("a.ts")), ev(2, msg()), ev(3, { type: "run.ended", outcome: "done" }), ev(4, { type: "instruction", text: "x", interrupt: false }), ev(5, diff("z.ts"))], false);
  assert.equal(after.filter((i) => i.kind === "event" && i.ev.body.type === "agent.diff").length, 2);
});

test("a lane since taken away keeps its name from the log: never \"Agent\" in what was said while it was there", async () => {
  const { agentNameFor, laneNamesFrom } = await import("../src/client/Activity.js");
  const added = { seq: 1, ts: 1, actor: { id: "u", name: "Arun", kind: "human" }, lane: "main", body: { type: "lane.added", lane: { id: "lane-juno", name: "Juno", agent: null, control: "open", controlMode: "open", trigger: "manual" } } } as unknown as SessionEvent;
  const renamed = { seq: 2, ts: 2, actor: { id: "u", name: "Arun", kind: "human" }, lane: "main", body: { type: "lane.renamed", laneId: "lane-pip", name: "Pip" } } as unknown as SessionEvent;
  laneNamesFrom([added, renamed]);
  const state = { engines: {}, lanes: [], options: {} } as unknown as Parameters<typeof agentNameFor>[0];
  assert.equal(agentNameFor(state, "lane-juno"), "Juno");
  assert.equal(agentNameFor(state, "lane-pip"), "Pip");
  assert.equal(agentNameFor(state, "never-seen"), "Agent");
});

test("every kind of event is drawn in the feed or left out of it: one drawn as nothing would still cut a run in two", async () => {
  const { readFileSync } = await import("node:fs");
  const types = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
  const union = types.slice(types.indexOf("export type EventBody"));
  const all = new Set([...union.slice(0, union.indexOf("\n\n")).matchAll(/\{ type: "([\w.]+)"/g)].map((m) => m[1]!));
  const src = readFileSync(new URL("../src/client/Activity.tsx", import.meta.url), "utf8");
  const between = (from: string, to: string) => {
    const i = src.indexOf(from);
    return src.slice(i, src.indexOf(to, i));
  };
  const drawn = new Set([...between("const EventItem = memo(function EventItem", "\n});").matchAll(/case "([\w.]+)"/g)].map((m) => m[1]!));
  const left = new Set([...between("const HIDDEN = new Set<string>([", "]);").matchAll(/"([\w.]+)"/g), ...between("const QUIET = new Set<string>([", "]);").matchAll(/"([\w.]+)"/g)].map((m) => m[1]!));
  assert.ok(all.size > 100, "the event kinds were read");
  assert.deepEqual([...all].filter((t) => !drawn.has(t) && !left.has(t)), [], "drawn by EventItem, or in HIDDEN");
  // A reaction on an answer doesn't split the run it falls in.
  const r = (seq: number, body: EventBody) => ({ seq, ts: seq, actor: { id: "u", name: "Arun", kind: "human" }, body }) as SessionEvent;
  const items = group([ev(1, { type: "agent.message", text: "One", toolCalls: [] }), r(2, { type: "message.reacted", seq: 1, reaction: "up" } as unknown as EventBody), ev(3, { type: "agent.message", text: "Two", toolCalls: [] })], false);
  assert.equal(items.length, 1, "one block");
});

test("a message an agent has answered is never \"queued\": a run it started counts as reading it, delivery logged or not", async () => {
  const { deliveredIn, stillPending, waitsOnPerson, isLongMessage } = await import("../src/client/Activity.js");
  const asked = { seq: 5, ts: 5, actor: { id: "u", name: "Arun", kind: "human" }, lane: "main", body: { type: "instruction", text: "Fix it", interrupt: false } } as unknown as SessionEvent;
  const started = { seq: 6, ts: 6, actor: { id: "a", name: "Claude Code", kind: "agent" }, lane: "main", body: { type: "run.started", causedBy: 5 } } as unknown as SessionEvent;
  const read = deliveredIn([asked, started]);
  assert.ok(read.has(5));
  // The session's queue still has it (no delivery was logged), and the client doesn't take that for waiting.
  const state = { pendingInstructions: [5, 7], lanePending: {}, run: { status: "running" }, laneRuns: {}, openQuestions: {}, approvals: {} } as unknown as Parameters<typeof stillPending>[0];
  assert.deepEqual(stillPending(state, "main", read), [7]);
  // A turn stopped on a question waits on the person: the feed, the queue and the box all say so.
  assert.equal(waitsOnPerson(state, "main"), false);
  assert.equal(waitsOnPerson({ ...state, openQuestions: { main: { to: "u" } } } as never, "main"), true);
  assert.equal(waitsOnPerson({ ...state, run: { status: "waiting_for_human" } } as never, "main"), true);
  // A long message folds to its first lines.
  assert.equal(isLongMessage("short"), false);
  assert.equal(isLongMessage("x".repeat(601)), true);
  assert.equal(isLongMessage(Array.from({ length: 12 }, () => "line").join("\n")), true);
});

test("a commit is held while any run in the session goes, as the server holds it", async () => {
  const { commitWaits } = await import("../src/client/Ship.js");
  assert.equal(commitWaits({ run: { status: "idle" }, laneRuns: { a: { status: "idle" } } } as never), false);
  assert.equal(commitWaits({ run: { status: "idle" }, laneRuns: { a: { status: "running" } } } as never), true);
  assert.equal(commitWaits({ run: { status: "running" }, laneRuns: {} } as never), true);
});

// Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes".
const human = (seq: number, body: EventBody): SessionEvent => ({ ...ev(seq, body), actor: { id: "u", name: "Ada", kind: "human" } }) as SessionEvent;
const said = (text: string, interrupted = false): EventBody => ({ type: "agent.message", text, toolCalls: [], ...(interrupted ? { interrupted: true } : {}) });

test("the runaway guard's pause ends the turn it paused: the block reads as stopped, not still at work", () => {
  const items = group([human(1, { type: "instruction", text: "LOOP", interrupt: false }), ev(2, { type: "run.started", causedBy: 1 }), ev(3, said("Running the tests")), ev(4, { type: "run.guarded", command: "npm test", times: 3, kind: "stuck" }), ev(5, { type: "run.pause" })], false);
  const run = items.find((i) => i.kind === "run") as Run;
  assert.equal(run.closedBy, "run.pause", "closed by the stop, not left open behind the guard's note");
});

test("a stopped turn keeps what it had written, in its own block above the stop's note", () => {
  const items = group([human(1, { type: "instruction", text: "SLOW", interrupt: false }), ev(2, { type: "run.started", causedBy: 1 }), ev(3, said("Working through it step by step.")), ev(4, { type: "run.pause" }), ev(5, said("Step 1. Step 2.", true))], false);
  const runs = items.filter((i) => i.kind === "run") as Run[];
  assert.equal(runs.length, 1, "no second block for the kept draft");
  assert.deepEqual(runs[0]!.messages.map((m) => m.body.text), ["Working through it step by step.", "Step 1. Step 2."]);
  const end = items.at(-1)!;
  assert.equal(end.kind === "event" ? end.ev.body.type : "", "run.pause", "the stop's note is last");
});

test("redirected, then stopped before the new answer's first message: each draft goes where it was cut", () => {
  const items = group(
    [
      human(1, { type: "instruction", text: "SLOW", interrupt: false }),
      ev(2, { type: "run.started", causedBy: 1 }),
      ev(3, said("Working through it.")),
      human(4, { type: "instruction", text: "RICH instead", interrupt: true }),
      ev(5, said("Step 1. Step 2.", true)),
      ev(6, { type: "instructions.delivered", seqs: [4] }),
      ev(7, { type: "run.pause" }),
      ev(8, said("I re-ran the sweep against the", true)),
    ],
    false,
  );
  const order = items.map((i) => (i.kind === "run" ? `run:${i.messages.map((m) => m.body.text).join("|")}` : i.ev.body.type));
  assert.deepEqual(order, ["instruction", "run:Working through it.|Step 1. Step 2.", "instruction", "run:I re-ran the sweep against the", "run.pause"]);
});

test("redirected mid-turn, then stopped: what it streamed stays under the redirect, above the stop, and stays stopped after the next send", () => {
  // Arun, 2026-10-28: "iron everything and ensure we are good". The redirect was handed to the running turn (delivered, no
  // interrupt); the Stop's draft then read "Worked for 29s" once the next message closed its block.
  const items = group(
    [
      human(1, { type: "instruction", text: "SLOW", interrupt: false }),
      ev(2, { type: "run.started", causedBy: 1 }),
      ev(3, said("Working through it step by step.")),
      human(4, { type: "instruction", text: "SLOW the other way", interrupt: false }),
      ev(5, { type: "instructions.delivered", seqs: [4] }),
      ev(6, { type: "run.pause" }),
      ev(7, said("Step 1. Step 2. Step 3.", true)),
      ev(8, diff("README.md")),
      human(9, { type: "instruction", text: "Write the intro", interrupt: false }),
    ],
    false,
  );
  const order = items.map((i) => (i.kind === "run" ? `run:${i.messages.map((m) => m.body.text).join("|")}` : i.ev.body.type));
  assert.deepEqual(order, ["instruction", "run:Working through it step by step.", "instruction", "run:Step 1. Step 2. Step 3.", "run.pause", "instruction"]);
  const stopped = items.find((i) => i.kind === "run" && i.messages[0]!.seq === 7) as Run;
  assert.equal(stopped.closedBy, "run.pause", "closed by the stop, not by the next message");
  assert.equal(stopped.diffs.length, 1, "its last change set is its own");
});

test("a turn's list of commands it asked about holds only its own, not every earlier turn's answers", () => {
  const ask = (seq: number, id: string): SessionEvent => ev(seq, { type: "engine.approval", id, scope: "commands", items: ["rm -rf build"] });
  const answer = (seq: number, id: string, approve: boolean) => human(seq, { type: "instruction", text: approve ? "Yes" : "No", interrupt: false, approval: { id, approve } });
  const items = group(
    [
      human(1, { type: "instruction", text: "ASK one", interrupt: false }),
      ev(2, { type: "run.started", causedBy: 1 }),
      ev(3, said("Reading")),
      ask(4, "a"),
      ev(5, { type: "run.ended", outcome: "waiting" }),
      answer(6, "a", false),
      ev(7, { type: "run.started", causedBy: 6 }),
      ev(8, said("Didn't remove it")),
      ev(9, { type: "run.ended", outcome: "done" }),
      human(10, { type: "instruction", text: "ASK two", interrupt: false }),
      ev(11, { type: "run.started", causedBy: 10 }),
      ev(12, said("Reading")),
      ask(13, "b"),
      ev(14, { type: "run.ended", outcome: "waiting" }),
      answer(15, "b", true),
      ev(16, { type: "run.started", causedBy: 15 }),
      ev(17, said("Removed it")),
      ev(18, { type: "run.ended", outcome: "done" }),
    ],
    false,
  );
  const runs = items.filter((i) => i.kind === "run") as Run[];
  assert.deepEqual(runs.map((r) => r.asked.map((a) => `${a.id}:${a.answer}`)), [["a:no"], ["a:no"], ["b:yes"], ["b:yes"]]);
});

// 2026-10-28 QA (Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"): editing a queued message left the old one in the feed as
// "Taken back before the agent read it", and a teammate's Edit left one over the message sent after it.
test("a queued message that was edited is drawn once, as it is now", () => {
  const said = (text: string, extra: object = {}): EventBody => ({ type: "instruction", text, interrupt: false, ...extra }) as EventBody;
  const shown = (events: SessionEvent[]) => group(events, false).flatMap((i) => (i.kind === "event" && i.ev.body.type === "instruction" ? [i.ev.body.text] : []));
  assert.deepEqual(shown([ev(1, said("Version one")), ev(2, said("Version two", { replaces: 1 })), ev(3, { type: "instruction.withdrawn", seq: 1 })]), ["Version two"]);
  assert.deepEqual(shown([ev(1, said("Draft")), ev(2, { type: "instruction.withdrawn", seq: 1, toEdit: true }), ev(3, said("Draft, changed"))]), ["Draft, changed"]);
  // Taken back for good is still said.
  assert.deepEqual(shown([ev(1, said("Never mind")), ev(2, { type: "instruction.withdrawn", seq: 1 })]), ["Never mind"]);
});
