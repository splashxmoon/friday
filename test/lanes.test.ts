import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext } from "../src/agent/context.js";
import { MAIN_LANE, type SessionEvent } from "../src/types.js";

const human = { id: "u1", name: "Arun", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

/** Minimal log: one instruction delivered, then a model turn with a tool call and its result. */
function log(): SessionEvent[] {
  return [
    { seq: 1, ts: 1, actor: human, body: { type: "instruction", text: "Do the thing", attachments: [] } },
    { seq: 2, ts: 2, actor: agent, body: { type: "instructions.delivered", seqs: [1] } },
    {
      seq: 3,
      ts: 3,
      actor: agent,
      body: { type: "agent.message", text: "", toolCalls: [{ id: "c-main", name: "read_document", arguments: "{}" }] },
    },
    { seq: 4, ts: 4, actor: agent, body: { type: "tool.result", callId: "c-main", name: "read_document", output: "main lane output" } },
    // A second lane's work, in the same log.
    {
      seq: 5,
      ts: 5,
      actor: agent,
      lane: "review",
      body: { type: "agent.message", text: "", toolCalls: [{ id: "c-review", name: "read_document", arguments: "{}" }] },
    },
    { seq: 6, ts: 6, actor: agent, lane: "review", body: { type: "tool.result", callId: "c-review", name: "read_document", output: "review lane output" } },
  ] as SessionEvent[];
}

const dump = (m: ReturnType<typeof buildContext>) => JSON.stringify(m);

test("a lane never sees another lane's model turns or tool results", () => {
  const main = dump(buildContext(log(), { lane: MAIN_LANE }));
  assert.ok(main.includes("c-main"), "own tool call is present");
  assert.ok(!main.includes("c-review"), "the other lane's tool call must not leak in");
  assert.ok(!main.includes("review lane output"), "the other lane's tool output must not leak in");

  // A lane always has a brief: its own, or the one it waits on (a reviewer woken by the main lane).
  const review = dump(buildContext(log(), { lane: "review", inherits: [MAIN_LANE] }));
  assert.ok(review.includes("c-review"), "own tool call is present");
  assert.ok(!review.includes("c-main"), "the main lane's tool call must not leak in");
});

test("what one lane was told is not told to the others", () => {
  // Telling the main agent a task must not hand it to every other agent in the room, or each one quietly
  // starts on work that was meant for someone else.
  const main = dump(buildContext(log(), { lane: MAIN_LANE }));
  assert.ok(main.includes("Do the thing"), "main acts on its own instruction");
  const review = dump(buildContext(log(), { lane: "review" }));
  assert.ok(!review.includes("Do the thing"), "another lane's instruction is not the review lane's to follow");

  const told: SessionEvent[] = [
    ...log(),
    { seq: 7, ts: 7, actor: human, lane: "review", body: { type: "instruction", text: "Audit the SEO", attachments: [] } },
    { seq: 8, ts: 8, actor: agent, lane: "review", body: { type: "instructions.delivered", seqs: [7] } },
  ] as SessionEvent[];
  assert.ok(dump(buildContext(told, { lane: "review" })).includes("Audit the SEO"), "the lane acts on what it was told");
  assert.ok(!dump(buildContext(told, { lane: MAIN_LANE })).includes("Audit the SEO"), "main must not pick up the review lane's task");
});

test("a lane that waits on another inherits that lane's brief, and no one else's", () => {
  // A reviewer woken when main finishes has no driver. What it knows of the task is what main was told.
  const review = dump(buildContext(log(), { lane: "review", inherits: [MAIN_LANE] }));
  assert.ok(review.includes("Do the thing"), "the waiting lane knows the task it is checking");
  const other = dump(buildContext(log(), { lane: "other", inherits: ["somebody-else"] }));
  assert.ok(!other.includes("Do the thing"));
});

test("every tool_call in a lane's context has its matching result", () => {
  // An unmatched tool_call id is a provider error, so this is the real failure mode
  // of filtering by lane: dropping a turn but keeping its result, or the reverse.
  for (const lane of [MAIN_LANE, "review"]) {
    const msgs = buildContext(log(), { lane });
    const asked = msgs.flatMap((m) => (m.role === "assistant" && m.tool_calls ? m.tool_calls.map((c) => c.id) : []));
    const answered = msgs.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));
    assert.deepEqual(asked, answered, `${lane}: every call is answered exactly once, in order`);
  }
});

test("an unlaned log is the main lane, so existing sessions are unchanged", () => {
  const unlaned = log().filter((e) => !e.lane);
  assert.equal(dump(buildContext(unlaned, { lane: MAIN_LANE })), dump(buildContext(unlaned)));
});
