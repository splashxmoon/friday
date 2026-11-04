// Crew: the audit of 2026-11-04 (audit/picks-CREW.md), its bugs with logic behind them.
import assert from "node:assert/strict";
import test from "node:test";
import { finishingOrder, roomOrder, type OrderInfo } from "../src/client/agent-order.js";
import { boardReportText, nudgedRepeats, plainLine, quoteBlock, roomAsks, splitQuote } from "../src/client/team-room.js";
import { keepGoingNote } from "../src/keep-going.js";
import { project } from "../src/session/projection.js";
import type { ActorRef, EventBody, SessionEvent } from "../src/types.js";

const human: ActorRef = { id: "u", name: "Arun", kind: "human" };
const tool: ActorRef = { id: "engine", name: "Claude Code", kind: "agent" };
const friday: ActorRef = { id: "friday", name: "Friday", kind: "system" };
const log = (rows: [ActorRef, EventBody, string?][]): SessionEvent[] => rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: 1000 * (i + 1), actor, body, ...(lane ? { lane } : {}) }) as SessionEvent);
const said = (text: string): EventBody => ({ type: "agent.message", text, toolCalls: [] });
const crew: [ActorRef, EventBody, string?][] = [
  [human, { type: "session.created", title: "Crew", ownerId: "u", ownerName: "Arun", options: { team: true } } as EventBody],
  [human, { type: "lane.added", lane: { id: "rex", name: "Rex", agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } } as EventBody],
  [tool, { type: "engine.attached", engine: { tool: "claude", hostId: "u", hostName: "Arun", online: true } } as unknown as EventBody, "rex"],
];
const QUESTIONS = ["Before I plan further: which thread?", "[1] What's the primary goal right now?", "- a. **Accuracy** — a new sweep", "- b. **Recall** — more data", "[2] Should I keep the baseline running?"].join("\n");

test("CREW-1: a teammate's questions dock in the room from the same ask its chat has, and an answer anywhere clears them", () => {
  const asked = log([...crew, [human, { type: "instruction", text: "QUESTIONS what next?", interrupt: false }, "rex"], [tool, { type: "run.started", causedBy: 4 }, "rex"], [tool, { type: "instructions.delivered", seqs: [4] }, "rex"], [tool, said(QUESTIONS), "rex"], [tool, { type: "run.ended", outcome: "done" }, "rex"]]);
  const s = project("s", asked);
  const docked = roomAsks(s, () => true);
  assert.equal(docked.length, 1);
  assert.equal(docked[0]!.lane, "rex");
  assert.equal(docked[0]!.seq, s.asks.rex!.seq, "the same ask its own chat answers");
  assert.equal(docked[0]!.questions.length, 2, "both questions");
  assert.deepEqual(roomAsks(s, () => false), [], "only for those who may answer");
  // Answered in Rex's chat, the room or Needs you: the answer is Rex's next instruction, and the card goes from everywhere.
  const answered = project("s", log([...crew, ...asked.slice(3).map((e) => [e.actor, e.body, e.lane] as [ActorRef, EventBody, string?]), [human, { type: "instruction", text: "1=a", interrupt: false }, "rex"]]));
  assert.deepEqual(roomAsks(answered, () => true), []);
});

test("CREW-2: a teammate held on the person mid-turn waits in the room, never works", async () => {
  const { noteLaneRuns, statusIn } = await import("../src/client/Teammates.js");
  const rex = { id: "t-rex", name: "Rex", lane: "rex", status: "waiting", line: "Wants to run `rm -rf build`", queued: 0 } as unknown as Parameters<typeof statusIn>[2];
  // Its run goes on (running) while its command waits for a yes: that is waiting.
  noteLaneRuns("crew-sid", { rex: { status: "running" }, nova: { status: "running" } }, (lane) => lane === "rex");
  assert.equal(statusIn("crew-sid", "rex", rex), "waiting");
  assert.equal(statusIn("crew-sid", "nova", { ...rex, lane: "nova", status: "working" }), "working");
});

test("CREW-3: the room keeps strict post order: a sent message never moves, and the result reads after the yes it waited on", () => {
  // Rex's turn starts (key 3), asks to run a command (5), the person says yes (6) and writes to Nova meanwhile (4); the turn posts
  // its result (8) and ends (9).
  type It = { id: string; info: OrderInfo };
  const items: It[] = [
    { id: "to-rex", info: { kind: "ask", lane: "rex", seq: 2 } },
    { id: "rex-run", info: { kind: "run", lane: "rex", ended: 8, live: false } },
    { id: "to-nova", info: { kind: "ask", lane: "nova", seq: 4 } },
    { id: "approval", info: { kind: "after", lane: "rex", seq: 5 } },
    { id: "yes", info: { kind: "ask", lane: "rex", seq: 6 } },
    { id: "nova-run", info: { kind: "run", lane: "nova", live: true } },
  ];
  const order = (room: boolean) => finishingOrder(items, (it) => (room ? roomOrder(it.info, false) : it.info), () => 0, new Set(["nova"])).map((x) => x.id);
  assert.deepEqual(order(true), ["to-rex", "to-nova", "approval", "yes", "rex-run", "nova-run"]);
  // A card still waiting stays with the turn under way, at the foot.
  assert.deepEqual(roomOrder({ kind: "after", lane: "rex", seq: 5 }, true), { kind: "after", lane: "rex", seq: 5 });
});

test("CREW-4: told to keep going with nothing to show for it, a teammate isn't told again, and the room posts its words once", () => {
  const todo = (...status: string[]): EventBody => ({ type: "agent.message", text: "", toolCalls: [{ id: "t", name: "todo", arguments: JSON.stringify({ todos: status.map((st, i) => ({ content: `step ${i}`, status: st })) }) }] });
  const nudge: EventBody = { type: "instruction", text: "Keep going: your plan still has 1 step open.", interrupt: false, keepGoing: true };
  const rows: [ActorRef, EventBody, string?][] = [
    [human, { type: "session.created", title: "t", ownerId: "u", ownerName: "Arun" } as EventBody],
    [human, { type: "instruction", text: "Ship the CSV export", interrupt: false }],
    [tool, { type: "run.started", causedBy: 2 }],
    [tool, { type: "instructions.delivered", seqs: [2] }],
    [tool, todo("completed", "completed", "pending")],
    [tool, said("## What I changed\n\n- the export")],
    [friday, nudge],
    [tool, { type: "instructions.delivered", seqs: [7] }],
    [tool, said("Done: I added a **Notes** section.")],
  ];
  // The first nudge got new words: on.
  const e1 = log(rows);
  assert.ok(keepGoingNote(project("s", e1), e1, "main"));
  // The second got the same words again and no step done: stop.
  const e2 = log([...rows, [friday, nudge], [tool, { type: "instructions.delivered", seqs: [10] }], [tool, said("Done: I added a Notes section.")]]);
  assert.equal(keepGoingNote(project("s", e2), e2, "main"), null);
  // The same words, but a step of its plan closed: that is progress.
  const e3 = log([...rows, [friday, nudge], [tool, { type: "instructions.delivered", seqs: [10] }], [tool, todo("completed", "completed", "completed")], [tool, said("Done: I added a Notes section.")]]);
  assert.equal(keepGoingNote(project("s", e3), e3, "main"), null, "its plan is done now: nothing to nudge for");
  // In the room: the repeat after a nudge is posted once; the person's own question answered the same way twice still shows.
  assert.deepEqual([...nudgedRepeats(e2)], [12]);
  const asked = log([...rows.slice(0, 6), [human, { type: "instruction", text: "Again?", interrupt: false }], [tool, { type: "instructions.delivered", seqs: [7] }], [tool, said("## What I changed\n\n- the export")]]);
  assert.deepEqual([...nudgedRepeats(asked)], []);
});

test("CREW-12: a board's report reads from the board's record: titles, not ids, and who did and checked each by their names now", () => {
  const rows: [ActorRef, EventBody, string?][] = [
    [human, { type: "session.created", title: "Crew", ownerId: "u", ownerName: "Arun" } as EventBody],
    [tool, { type: "board.posted", fromLane: "nova", fromName: "Nova", tasks: [{ id: "s1", title: 'Board task "Test sweep": Run the tests and fix what fails', after: [] }] } as unknown as EventBody, "nova"],
    [tool, { type: "board.claimed", id: "s1", lane: "kit", name: "arundass's Codex" } as EventBody, "kit"],
    [tool, { type: "board.finished", id: "s1", lane: "kit", name: "arundass's Codex", status: "done", report: "All green." } as EventBody, "kit"],
    [tool, { type: "board.reviewed", id: "s1", lane: "ada", name: "Rex", ok: true, note: "Fine." } as EventBody, "ada"],
  ];
  const e = log(rows);
  const names: Record<string, string> = { kit: "Kit", ada: "Ada" };
  const said = boardReportText("## s1: Run the tests and fix what fails (done by arundass's Codex, approved by Rex)\nAll green.", e, 99, (l) => names[l]);
  assert.equal(said, "## Run the tests and fix what fails (done by Kit, approved by Ada)\nAll green.");
  assert.doesNotMatch(plainLine(said), /s1:/);
});

test("CREW-16: one-line previews are plain text", () => {
  assert.equal(plainLine("Done: I added a **Notes** section to `README.md`.\n\n- Read the README"), "Done: I added a Notes section to README.md. Read the README");
});

test("CREW-21: a quote goes as one Markdown block before the words, and comes back as its words and the rest", () => {
  const sent = `${quoteBlock("Removed the old build folder")}\n\nQUESTIONS what next?`;
  assert.equal(sent, "> Removed the old build folder\n\nQUESTIONS what next?");
  assert.deepEqual(splitQuote(sent), { quote: "Removed the old build folder", rest: "QUESTIONS what next?" });
  assert.deepEqual(splitQuote("> a\n>\n> b\n\n\nhello"), { quote: "a\n\nb", rest: "hello" });
  assert.equal(splitQuote("no quote > here"), null);
});

test("CREW-25: a teammate waiting on you says what it asks once, never \"Needs you: Needs a decision: …\"", async () => {
  const { sayMate } = await import("../src/client/team-status.js");
  const rex = { name: "Rex", tool: "claude", status: "waiting", line: "Needs a decision: What's the primary goal right now?", queued: 0 } as const;
  assert.equal(sayMate({ ...rex }).line, "Needs you: What's the primary goal right now?");
  assert.equal(sayMate({ ...rex, line: "Wants to run rm -rf build" }).line, "Needs you: Wants to run rm -rf build");
});
