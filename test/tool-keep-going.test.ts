import assert from "node:assert/strict";
import { test } from "node:test";
import { keepGoingNote, MAX_KEEP_GOING } from "../src/keep-going.js";
import { project, type SessionState } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/**
 * A coding tool keeps working until its task is done (keep-going.ts, Arun, 2026-10-20): a turn that ends short of it gets a
 * "keep going", and one that is finished, waiting on a person, or only planning doesn't.
 */

const human: ActorRef = { id: "u-ada", name: "Ada", kind: "human" };
const tool: ActorRef = { id: "engine", name: "Claude Code", kind: "agent" };
const friday: ActorRef = { id: "friday", name: "Friday", kind: "system" };

function log(rows: [ActorRef, EventBody, string?][]): SessionEvent[] {
  return rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: Date.now(), actor, body, ...(lane && lane !== MAIN_LANE ? { lane } : {}) }) as SessionEvent);
}
const todo = (...status: string[]): EventBody => ({ type: "agent.message", text: "", toolCalls: [{ id: "t", name: "todo", arguments: JSON.stringify({ todos: status.map((s, i) => ({ content: `step ${i}`, status: s })) }) }] });
const said = (text: string): EventBody => ({ type: "agent.message", text, toolCalls: [] });
const start: [ActorRef, EventBody][] = [
  [human, { type: "session.created", title: "t", ownerId: human.id, ownerName: human.name }],
  [human, { type: "instruction", text: "Build the parser and its tests.", interrupt: false }],
  [tool, { type: "run.started", causedBy: 2 }],
  [tool, { type: "instructions.delivered", seqs: [2] }],
];
const at = (...more: [ActorRef, EventBody][]): [SessionState, SessionEvent[]] => {
  const events = log([...start, ...more]);
  return [project("s", events), events];
};

test("a turn that ends with its own plan still open is told to keep going, and one with the plan done is not", () => {
  const [s, e] = at([tool, todo("completed", "pending", "in_progress")], [tool, said("Wrote the parser.")]);
  assert.match(keepGoingNote(s, e, MAIN_LANE) ?? "", /^Keep going: your plan still has 2 steps open\. Nobody asked you to stop/);
  const [done, e2] = at([tool, todo("completed", "completed", "cancelled")], [tool, said("Both done.")]);
  assert.equal(keepGoingNote(done, e2, MAIN_LANE), null);
  // A plan from an earlier run is history.
  const old = log([...start.slice(0, 2), [tool, todo("pending")], [tool, { type: "run.started", causedBy: 2 }], [tool, said("Done.")]]);
  assert.equal(keepGoingNote(project("s", old), old, MAIN_LANE), null);
});

test("a turn that ends on what it will do next keeps going; one that ends on a question waits for its answer", () => {
  const [s, e] = at([tool, said("The parser is in. Next I'll add the tests.")]);
  assert.match(keepGoingNote(s, e, MAIN_LANE) ?? "", /you said what you would do next/);
  const [q, e2] = at([tool, todo("completed", "pending")], [tool, said("Should the tests cover time zones?")]);
  assert.equal(keepGoingNote(q, e2, MAIN_LANE), null);
});

test("waiting on a person, only planning, or told enough times this run: its turn's end is the end", () => {
  const open: [ActorRef, EventBody][] = [[tool, todo("pending")], [tool, said("Started.")]];
  const [s, e] = at(...open);
  assert.ok(keepGoingNote(s, e, MAIN_LANE));
  assert.equal(keepGoingNote({ ...s, approvals: { [MAIN_LANE]: { id: "a", items: ["rm -rf build"], scope: "commands" } } } as unknown as SessionState, e, MAIN_LANE), null, "a command to approve");
  assert.equal(keepGoingNote({ ...s, engines: { [MAIN_LANE]: { mode: "plan" } } } as unknown as SessionState, e, MAIN_LANE), null, "plan mode stops after the plan");
  assert.equal(keepGoingNote({ ...s, run: { status: "idle", sinceSeq: 0 } }, e, MAIN_LANE), null, "stopped: on standby, not pushed on");
  const nudges = Array.from({ length: MAX_KEEP_GOING }, (): [ActorRef, EventBody] => [friday, { type: "instruction", text: "Keep going", interrupt: false, keepGoing: true }]);
  const [many, e2] = at(...nudges, ...open);
  assert.equal(keepGoingNote(many, e2, MAIN_LANE), null, `${MAX_KEEP_GOING} times a run at most`);
});

test("a board task it took and never finished keeps it going, and the nudge says to keep the others posted", () => {
  const [s, e] = at(
    [human, { type: "lane.added", lane: { id: "lb", name: "Builder", agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } } as EventBody],
    [tool, { type: "board.posted", fromLane: "lb", fromName: "Builder", tasks: [{ id: "api", title: "Build the API", detail: "", owns: [], after: [] }] } as EventBody],
    [tool, { type: "board.claimed", id: "api", lane: MAIN_LANE, name: "Claude Code" }],
    [tool, said("Built the routes.")],
  );
  const note = keepGoingNote(s, e, MAIN_LANE) ?? "";
  assert.match(note, /the board task "Build the API" isn't finished/);
  assert.match(note, /check_messages.*post_update/, "with other agents here, it checks in and posts as it goes");
});
