import assert from "node:assert/strict";
import test from "node:test";
import { teamTasks } from "../src/client/AgentTalk.js";
import { project } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type MeshNote, type SessionEvent } from "../src/types.js";

/**
 * The team's tasks above the composer (AgentTalk.tsx teamTasks): every task the agents handed each other, with who has it and
 * where it stands in a word, from the board and from what the lead assigned.
 */

const ADA = { id: "u-ada", name: "Ada" };
const human: ActorRef = { ...ADA, kind: "human" };
const bot = (name: string): ActorRef => ({ id: `agent:${name}`, name, kind: "agent" });
const log = (rows: [ActorRef, EventBody, string?][]): SessionEvent[] => rows.map(([actor, body, lane], i) => ({ seq: i + 1, ts: Date.now(), actor, body, ...(lane && lane !== MAIN_LANE ? { lane } : {}) }) as SessionEvent);
const task = (over: Partial<MeshNote>): MeshNote => ({ id: "t1", kind: "task", fromLane: MAIN_LANE, fromName: "Main", toName: "Codex", hop: 1, by: ADA, ...over });
const lane = (id: string, name: string): EventBody => ({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } }) as EventBody;
const rows = (s: ReturnType<typeof project>) => teamTasks(s, () => {}).map((t) => [t.title, t.status, t.note]);

test("the board's tasks: ready, waiting on another, being done, being checked, stuck and done, each in a word", () => {
  const events = log([
    [human, { type: "session.created", title: "t", ownerId: ADA.id, ownerName: ADA.name }],
    [human, lane("lb", "Builder")],
    [human, lane("lw", "Writer")],
    [
      bot("Main"),
      {
        type: "board.posted",
        fromLane: MAIN_LANE,
        fromName: "Main",
        tasks: [
          { id: "api", title: "Build the API", detail: "GET /orders", owns: [], after: [] },
          { id: "ui", title: "Wire the UI", detail: "", owns: [], after: ["api"] },
          { id: "docs", title: "Write the docs", detail: "", owns: [], after: [] },
          { id: "e2e", title: "Run the end-to-end tests", detail: "", owns: [], after: [] },
          { id: "copy", title: "Fix the copy", detail: "", owns: [], after: [] },
        ],
      },
    ],
    [bot("Builder"), { type: "run.started", causedBy: 1 }, "lb"],
    [bot("Builder"), { type: "board.claimed", id: "api", lane: "lb", name: "Builder" }],
    [bot("Writer"), { type: "board.claimed", id: "docs", lane: "lw", name: "Writer" }],
    [bot("Writer"), { type: "board.finished", id: "docs", lane: "lw", name: "Writer", status: "done", report: "Wrote them." }],
    [bot("Builder"), { type: "board.review", id: "docs", lane: "lb", name: "Builder" }],
    [bot("Builder"), { type: "board.claimed", id: "e2e", lane: "lb", name: "Builder" }],
    [bot("Builder"), { type: "board.finished", id: "e2e", lane: "lb", name: "Builder", status: "blocked", report: "No browser." }],
  ]);
  // What is being worked on first, then what waits, then what is finished, each in the order posted (Arun, 2026-10-21).
  assert.deepEqual(rows(project("s", events)), [
    ["Build the API", "active", "Working"],
    ["Write the docs", "active", "Builder checking"],
    ["Wire the UI", "pending", "After Build the API"],
    ["Run the end-to-end tests", "pending", "Stuck"],
    ["Fix the copy", "pending", "Ready"],
  ]);
  events.push(...log([[bot("Builder"), { type: "board.reviewed", id: "docs", lane: "lb", name: "Builder", ok: true, note: "Good." }]]).map((e) => ({ ...e, seq: 12 })));
  assert.deepEqual(rows(project("s", events)).at(-1), ["Write the docs", "completed", "Checked"], "finished, it goes to the end");
});

test("a claimed task says what its agent is doing now, not only that it took it", () => {
  const base: [ActorRef, EventBody, string?][] = [
    [human, { type: "session.created", title: "t", ownerId: ADA.id, ownerName: ADA.name }],
    [human, lane("lb", "Builder")],
    [bot("Main"), { type: "board.posted", fromLane: MAIN_LANE, fromName: "Main", tasks: [{ id: "api", title: "Build the API", detail: "", owns: [], after: [] }] } as EventBody],
    [bot("Builder"), { type: "board.claimed", id: "api", lane: "lb", name: "Builder" }],
  ];
  const at = (more: [ActorRef, EventBody, string?][]) => rows(project("s", log([...base, ...more])))[0];
  assert.deepEqual(at([]), ["Build the API", "pending", "Not finished"], "claimed, but its agent isn't running");
  assert.deepEqual(at([[bot("Builder"), { type: "run.started", causedBy: 1 }, "lb"]]), ["Build the API", "active", "Working"]);
  assert.deepEqual(at([[bot("Builder"), { type: "run.started", causedBy: 1 }, "lb"], [bot("Builder"), { type: "run.ended", outcome: "waiting" }, "lb"]]), ["Build the API", "active", "Needs you"]);
  assert.deepEqual(at([[bot("Builder"), { type: "run.started", causedBy: 1 }, "lb"], [bot("Builder"), { type: "run.ended", outcome: "error", error: "x" }, "lb"]]), ["Build the API", "pending", "Stopped"]);
  assert.deepEqual(at([[bot("Builder"), { type: "run.started", causedBy: 1 }, "lb"], [bot("Builder"), { type: "run.ended", outcome: "done" }, "lb"]]), ["Build the API", "pending", "Not finished"], "its run ended without marking it done");
});

test("what the lead assigned: queued until its agent has it, never held by an old pause of agent talk, and done once it reports back", () => {
  const events = log([
    [human, { type: "session.created", title: "t", ownerId: ADA.id, ownerName: ADA.name }],
    [human, lane("lc", "Codex")],
    [bot("Main"), { type: "instruction", text: "Please build the date parser in src/date.ts.\nKeep offsets.", interrupt: false, mesh: task({}) }, "lc"],
  ]);
  assert.deepEqual(rows(project("s", events)), [["Build the date parser in src/date.ts.", "pending", "Queued"]]);
  events.push(...log([[human, { type: "mesh.paused", on: true }]]).map((e) => ({ ...e, seq: 4 })));
  assert.deepEqual(rows(project("s", events))[0]!.slice(1), ["pending", "Queued"], "agent talk is never paused (Arun, 2026-10-20)");
  events.push(
    ...log([
      [human, { type: "mesh.paused", on: false }],
      [bot("Codex"), { type: "mesh.replied", id: "t1", fromLane: "lc", fromName: "Codex", toLane: MAIN_LANE, toName: "Main", text: "Built it." }],
    ]).map((e, i) => ({ ...e, seq: 5 + i })),
  );
  assert.deepEqual(rows(project("s", events))[0]!.slice(1), ["completed", "Reported back"]);
  assert.deepEqual(teamTasks(project("s", log([[human, { type: "session.created", title: "t", ownerId: ADA.id, ownerName: ADA.name }]])), () => {}), [], "nothing handed out, no list");
});

test("the current round only: once every task has reported back, the next one assigned starts the list afresh", () => {
  const assign = (id: string, text: string): [ActorRef, EventBody, string] => [bot("Main"), { type: "instruction", text, interrupt: false, mesh: task({ id }) }, "lc"];
  const report = (id: string): [ActorRef, EventBody] => [bot("Codex"), { type: "mesh.replied", id, fromLane: "lc", fromName: "Codex", toLane: MAIN_LANE, toName: "Main", text: "Done." }];
  const events = log([
    [human, { type: "session.created", title: "t", ownerId: ADA.id, ownerName: ADA.name }],
    [human, lane("lc", "Codex")],
    assign("t1", "Build the parser."),
    assign("t2", "Write its tests."),
    report("t1"),
  ]);
  assert.deepEqual(rows(project("s", events)).map((r) => r[0]), ["Write its tests.", "Build the parser."], "one still open: the round goes on, the open one first");
  events.push(...log([report("t2"), assign("t3", "Ship it.")]).map((e, i) => ({ ...e, seq: 6 + i })));
  assert.deepEqual(rows(project("s", events)), [["Ship it.", "pending", "Queued"]]);
});
