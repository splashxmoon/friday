import assert from "node:assert/strict";
import test from "node:test";
import { buildContext } from "../src/agent/context.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/**
 * The agent asking the same question twice.
 *
 * A question and its answer are a pair of ordinary turns, so a long session
 * trims them away like any other pair — and an agent that cannot see it
 * asked already does the only thing it can, which is ask again. That is the
 * loop people hit: ask, answer, work for twenty turns, lose the pair, ask
 * the same question.
 *
 * So the settled decisions are carried in front of the transcript instead of
 * living inside it, where trimming cannot reach them.
 */

const ARUN = { id: "u-arun", name: "Arun", kind: "human" as const };
const AGENT = { id: "agent", name: "Friday", kind: "agent" as const };

const log = (rows: [typeof ARUN | typeof AGENT, EventBody][]): SessionEvent[] =>
  rows.map(([actor, body], i) => ({ seq: i + 1, ts: 1000 + i, actor, body }) as SessionEvent);

const ask = (question: string): EventBody => ({ type: "agent.question", callId: "c1", question, to: "u-arun", toName: "Arun" });
const said = (text: string): EventBody => ({ type: "instruction", text, interrupt: false, attachments: [] });

const EVENTS = log([
  [ARUN, said("Fix the cart")],
  [AGENT, { type: "instructions.delivered", seqs: [1] }],
  [AGENT, ask("Merge the carts, or replace the anonymous one?")],
  [ARUN, said("Merge them")],
  [AGENT, { type: "instructions.delivered", seqs: [4] }],
]);

const all = (msgs: ReturnType<typeof buildContext>) => msgs.map((m) => String(m.content ?? "")).join("\n");

test("a question and its answer are stated up front, as settled", () => {
  const text = all(buildContext(EVENTS));
  assert.match(text, /Merge the carts, or replace the anonymous one\? → Merge them/);
  assert.match(text, /do not ask about them again/i);
});

/**
 * The case that matters: the turns holding the exchange are long gone, and
 * the decision has to have outlived them.
 */
test("the decision survives the transcript being trimmed away", () => {
  const long = log([
    [ARUN, said("Fix the cart")],
    [AGENT, { type: "instructions.delivered", seqs: [1] }],
    [AGENT, ask("Merge the carts, or replace the anonymous one?")],
    [ARUN, said("Merge them")],
    [AGENT, { type: "instructions.delivered", seqs: [4] }],
    ...Array.from({ length: 40 }, (_, i): [typeof AGENT, EventBody] => [
      AGENT,
      { type: "agent.message", text: `step ${i} ${"x".repeat(400)}`, toolCalls: [] },
    ]),
  ]);
  const msgs = buildContext(long, { budget: 2000 });
  const text = all(msgs);
  assert.ok(text.includes("earlier turns were dropped"), "the transcript really was trimmed");
  assert.match(text, /Merge the carts, or replace the anonymous one\? → Merge them/, "and the answer is still there");
});

/** A question nobody has answered yet is not a decision; it is still open. */
test("an unanswered question is not listed as settled", () => {
  const waiting = log([
    [ARUN, said("Fix the cart")],
    [AGENT, { type: "instructions.delivered", seqs: [1] }],
    [AGENT, ask("Merge the carts, or replace the anonymous one?")],
  ]);
  assert.ok(!all(buildContext(waiting)).includes("Decisions already made"));
});

test("several decisions read as a list, newest last", () => {
  const two = log([
    [ARUN, said("Start")],
    [AGENT, { type: "instructions.delivered", seqs: [1] }],
    [AGENT, ask("Merge or replace?")],
    [ARUN, said("Merge")],
    [AGENT, { type: "instructions.delivered", seqs: [4] }],
    [AGENT, ask("Postgres or SQLite?")],
    [ARUN, said("Postgres")],
    [AGENT, { type: "instructions.delivered", seqs: [7] }],
  ]);
  const text = all(buildContext(two));
  assert.ok(text.indexOf("Merge or replace?") < text.indexOf("Postgres or SQLite?"));
});

test("a session with no questions gains nothing", () => {
  const plain = log([
    [ARUN, said("Fix the cart")],
    [AGENT, { type: "instructions.delivered", seqs: [1] }],
  ]);
  assert.ok(!all(buildContext(plain)).includes("Decisions already made"));
});
