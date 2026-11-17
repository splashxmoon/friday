// The lead's team put to the person first (Arun, 2026-11-16, "Do 5"): a proposed board holds, Start the team releases it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { project } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

const human: ActorRef = { id: "u-ada", name: "Ada", kind: "human" };
const bot: ActorRef = { id: "agent", name: "Claude Code", kind: "agent" };
const log = (rows: [ActorRef, EventBody][]): SessionEvent[] => rows.map(([actor, body], i) => ({ seq: i + 1, ts: Date.now(), actor, body }));
const tasks = [
  { id: "totals", title: "Fix the totals", detail: "x", owns: ["src/totals.ts"], after: [] },
  { id: "tests", title: "Write the tests", detail: "y", owns: ["test/tax.test.ts"], after: [] },
];

test("a proposed board is held until the person starts it, and then is the ordinary board", () => {
  const posted = log([
    [human, { type: "session.created", title: "t", ownerId: "u-ada", ownerName: "Ada" } as EventBody],
    [bot, { type: "board.posted", fromLane: MAIN_LANE, fromName: "Claude Code", tasks, proposed: true }],
  ]);
  const held = project("s", posted);
  assert.equal(held.board?.proposed, true);
  assert.deepEqual(held.board?.tasks.map((t) => t.status), ["open", "open"]);
  const started = project("s", [...posted, { seq: 3, ts: Date.now(), actor: human, body: { type: "board.started" } }]);
  assert.equal(started.board?.proposed, undefined, "started: nothing holds it any more");
  assert.equal(started.board?.tasks.length, 2);
  const plain = project("s", log([
    [human, { type: "session.created", title: "t", ownerId: "u-ada", ownerName: "Ada" } as EventBody],
    [bot, { type: "board.posted", fromLane: MAIN_LANE, fromName: "Claude Code", tasks }],
  ]));
  assert.equal(plain.board?.proposed, undefined, "a board not proposed goes out as before");
});
