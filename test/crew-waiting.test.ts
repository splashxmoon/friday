// Who a crew mate waits on (client/crew-waiting.tsx waitingOn): its asks and hand-outs since the person last wrote, each as it
// stands, and nothing once all have answered.
import assert from "node:assert/strict";
import test from "node:test";
import { waitingOn } from "../src/client/crew-waiting.js";

const ev = (seq: number, lane: string, body: unknown, kind: "human" | "agent" = "agent") => ({ seq, ts: seq, lane, actor: { id: "x", name: "x", kind }, body }) as never;

test("asked, working and replied, then nothing once every one has answered", () => {
  const events = [
    ev(1, "lead", { type: "instruction", text: "Ship the FAQ", interrupt: false }, "human"),
    ev(2, "kit", { type: "instruction", text: "Draft it", interrupt: false, mesh: { id: "a1", kind: "task", fromLane: "lead", fromName: "Nova", toName: "Kit" } }),
    ev(3, "rex", { type: "instruction", text: "Review it", interrupt: false, mesh: { id: "a2", kind: "ask", fromLane: "lead", fromName: "Nova", toName: "Rex" } }),
    ev(4, "kit", { type: "instructions.delivered", seqs: [2] }),
  ];
  const state = { laneRuns: { kit: { status: "running" } }, approvals: {}, openQuestions: {} } as never;
  assert.deepEqual(waitingOn(events, state, "lead").map((w) => [w.name, w.state]), [["Kit", "working"], ["Rex", "asked"]]);
  const replied = [...events, ev(5, "lead", { type: "mesh.replied", id: "a1", fromLane: "kit", fromName: "Kit", toLane: "lead", toName: "Nova", text: "Drafted." })];
  assert.deepEqual(waitingOn(replied, state, "lead").map((w) => [w.name, w.state]), [["Kit", "replied"], ["Rex", "asked"]]);
  const all = [...replied, ev(6, "lead", { type: "instruction", text: "Looks good", interrupt: false, mesh: { id: "r9", kind: "reply", re: "a2", fromLane: "rex", fromName: "Rex", toName: "Nova" } })];
  assert.deepEqual(waitingOn(all, state, "lead"), []);
  // A new word from the person starts over: what was asked before it is past.
  assert.deepEqual(waitingOn([...events, ev(7, "lead", { type: "instruction", text: "New thing", interrupt: false }, "human")], state, "lead"), []);
});

test("a draft to send waits on the person until they write to its crew mate", async () => {
  const { pendingDraft } = await import("../src/client/crew-waiting.js");
  const call = { id: "c1", name: "mcp__friday__propose_send", arguments: JSON.stringify({ via: "Email", to: "ana@example.com", subject: "FAQ", body: "Here is the FAQ." }) };
  const events = [ev(1, "kit", { type: "instruction", text: "Email Ana the FAQ", interrupt: false }, "human"), ev(2, "kit", { type: "agent.message", text: "", toolCalls: [call] })];
  assert.deepEqual(pendingDraft(events, "kit"), { id: "c1", via: "Email", to: "ana@example.com", subject: "FAQ", body: "Here is the FAQ." });
  assert.equal(pendingDraft([...events, ev(3, "kit", { type: "instruction", text: "Send it", interrupt: false }, "human")], "kit"), null);
  assert.equal(pendingDraft(events, "rex"), null);
});
