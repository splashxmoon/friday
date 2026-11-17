// A person's stacked tasks: one a turn, in the order sent, and none lost with a turn they were slipped into (Arun, 2026-11-16: "if
// i stack a bunch of tasks for the coding tool in the coding session or even the agents like it will work in order of what was said
// to be worked on and nothing gets skipped").
import assert from "node:assert/strict";
import test from "node:test";
import { cutTurnOf, OWED_HEAD, oneTaskAhead, owedNote, steeredOwed } from "../src/engine/hub.js";
import { MAIN_LANE, type EventBody, type SessionEvent } from "../src/types.js";

const ada = { id: "ada", name: "Ada", kind: "human" as const };
const kit = { id: "agent:kit", name: "Kit", kind: "agent" as const };
const friday = { id: "friday", name: "Friday", kind: "system" as const };
let seq = 0;
const ev = (actor: SessionEvent["actor"], body: EventBody, lane = MAIN_LANE): SessionEvent => ({ seq: ++seq, ts: seq, actor, body, ...(lane !== MAIN_LANE ? { lane } : {}) }) as SessionEvent;
const say = (actor: SessionEvent["actor"], text: string, more: Record<string, unknown> = {}) => ev(actor, { type: "instruction", text, interrupt: false, attachments: [], ...more } as EventBody);

test("one of a person's tasks a turn, with the other agents' and Friday's messages around the first", () => {
  seq = 0;
  const a = say(ada, "fix the cart");
  const m = say(kit, "fyi the tests are flaky");
  const b = say(ada, "then the receipts");
  const c = say(ada, "then the docs");
  const yes = say(ada, "yes", { approval: { id: "x", approve: true } });
  const events = [a, m, b, c, yes];
  assert.deepEqual(oneTaskAhead(events, [a.seq, m.seq, b.seq, c.seq]), [a.seq, m.seq]);
  assert.deepEqual(oneTaskAhead(events, [b.seq, c.seq]), [b.seq]);
  assert.deepEqual(oneTaskAhead(events, [m.seq, b.seq]), [m.seq, b.seq], "an agent's message ahead of it goes with it");
  assert.deepEqual(oneTaskAhead(events, [yes.seq, c.seq]), [yes.seq, c.seq], "an answer to a question is not a task");
  assert.deepEqual(oneTaskAhead(events, []), []);
});

test("what a person slipped into a turn is owed until it is checked on; one the tool couldn't take isn't", () => {
  seq = 0;
  const a = say(ada, "fix the cart");
  const started = ev(ada, { type: "run.started", causedBy: a.seq } as EventBody);
  const d0 = ev(friday, { type: "instructions.delivered", seqs: [a.seq], turn: "t1" } as EventBody);
  const b = say(ada, "also the receipts");
  const db = ev(friday, { type: "instructions.delivered", seqs: [b.seq], steer: true } as EventBody);
  const m = say(kit, "tests are flaky");
  const dm = ev(friday, { type: "instructions.delivered", seqs: [m.seq], steer: true } as EventBody);
  const c = say(ada, "and the docs");
  const dc = ev(friday, { type: "instructions.delivered", seqs: [c.seq], steer: true } as EventBody);
  const back = ev(friday, { type: "instructions.requeued", seqs: [c.seq], steer: true } as EventBody);
  let events = [a, started, d0, b, db, m, dm, c, dc, back];
  assert.deepEqual(steeredOwed(events, MAIN_LANE), [b.seq], "the person's, taken, not the agent's, not the one put back");
  const note = owedNote(events, [b.seq]);
  assert.ok(note.startsWith(OWED_HEAD));
  assert.match(note, /Ada: also the receipts/);
  const d = say(ada, "and the changelog");
  const dd = ev(friday, { type: "instructions.delivered", seqs: [d.seq], steer: true } as EventBody);
  assert.match(owedNote([...events, d, dd], [b.seq, d.seq]), /in this order:\n1\. Ada: also the receipts\n2\. Ada: and the changelog/);
  // Checked on: owed no longer, until something new is slipped in.
  const check = say(friday, note, { keepGoing: true });
  events = [...events, check];
  assert.deepEqual(steeredOwed(events, MAIN_LANE), []);
  assert.deepEqual(steeredOwed([...events, d, dd], MAIN_LANE), [d.seq]);
  // A new run starts afresh.
  assert.deepEqual(steeredOwed([...events, d, dd, ev(ada, { type: "run.started", causedBy: d.seq } as EventBody)], MAIN_LANE), []);
});

test("a server gone mid-turn puts back everything the turn held, not only the last message slipped into it", () => {
  seq = 0;
  const a = say(ada, "fix the cart");
  const b = say(ada, "also the receipts");
  const c = say(ada, "and the docs");
  const events = [a, ev(ada, { type: "run.started", causedBy: a.seq } as EventBody), ev(friday, { type: "instructions.delivered", seqs: [a.seq], turn: "t1" } as EventBody), b, ev(friday, { type: "instructions.delivered", seqs: [b.seq], steer: true } as EventBody), c, ev(friday, { type: "instructions.delivered", seqs: [c.seq], steer: true } as EventBody)];
  assert.deepEqual(cutTurnOf(events, MAIN_LANE), { seqs: [a.seq, b.seq, c.seq], turn: "t1" });
});
