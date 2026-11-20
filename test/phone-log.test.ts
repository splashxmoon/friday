import assert from "node:assert/strict";
import test from "node:test";
import { phoneLog, phonePage } from "../src/phone-log.js";
import type { SessionEvent } from "../src/types.js";

/** What a phone gets of a session's log on joining (phone-log.ts): what its feed draws, the newest of it per lane, cut down. */
const actor = { id: "a", name: "Ann", kind: "human" as const };
const ev = (seq: number, body: SessionEvent["body"], lane?: string): SessionEvent => ({ seq, ts: seq, actor, body, ...(lane ? { lane } : {}) });

test("only the kinds the phone's feed draws, in order", () => {
  const log = [
    ev(1, { type: "instruction", text: "hi", interrupt: false }),
    ev(2, { type: "run.started" } as SessionEvent["body"]),
    ev(3, { type: "agent.message", text: "done", toolCalls: [] }),
  ];
  assert.deepEqual(phoneLog(log).map((e) => e.seq), [1, 3]);
});

test("subagents and background commands come too, for the Background tasks sheet, without pushing messages out", () => {
  const log: SessionEvent[] = [ev(1, { type: "instruction", text: "go", interrupt: false })];
  for (let i = 2; i <= 60; i++) log.push(ev(i, { type: "agent.task", id: `t${i}`, status: "running", description: "npm run dev", agentType: "command", background: true } as SessionEvent["body"]));
  const got = phoneLog(log, 1);
  assert.equal(got[0]!.seq, 1, "the one message is kept");
  assert.equal(got.filter((e) => e.body.type === "agent.task").length, 59);
});

test("the newest per lane, so a quiet lane keeps its own", () => {
  const log = [ev(1, { type: "instruction", text: "side", interrupt: false }, "l2")];
  for (let i = 2; i <= 10; i++) log.push(ev(i, { type: "instruction", text: `m${i}`, interrupt: false }));
  assert.deepEqual(phoneLog(log, 3).map((e) => e.seq), [1, 8, 9, 10]);
});

test("tool output and arguments cut to what the phone shows, reasoning dropped, arguments still JSON", () => {
  const big = "x".repeat(5000);
  const log = [
    ev(1, { type: "agent.message", text: "", toolCalls: [{ id: "c", name: "write_file", arguments: JSON.stringify({ path: "src/a.ts", content: big }) }], reasoning: [{ big }] }),
    ev(2, { type: "tool.result", callId: "c", name: "write_file", output: big, isError: false }),
  ];
  const [call, result] = phoneLog(log);
  assert.ok(call.body.type === "agent.message" && !("reasoning" in call.body));
  assert.ok(call.body.type === "agent.message" && JSON.parse(call.body.toolCalls[0].arguments).path === "src/a.ts");
  assert.ok(result.body.type === "tool.result" && result.body.output.length === 400);
});

test("a page further back: one lane's shown events before a point, newest last, and whether there are more", () => {
  const log: SessionEvent[] = [];
  for (let i = 1; i <= 10; i++) log.push(ev(i, { type: "instruction", text: `m${i}`, interrupt: false }, i % 2 ? undefined : "l2"));
  const page = phonePage(log, "main", 9, 2);
  assert.deepEqual(page.events.map((e) => e.seq), [5, 7]);
  assert.equal(page.more, true);
  const last = phonePage(log, "main", 5, 2);
  assert.deepEqual(last.events.map((e) => e.seq), [1, 3]);
  assert.equal(last.more, false);
});

test("a plan's steps reach the phone whole, each step's words cut short, for its plan strip", () => {
  const todos = ["Read the cart code", "Fix the rounding", "Add a test", "Run the tests"].map((content, n) => ({ content: content + " ".repeat(n ? 0 : 1) + "y".repeat(n ? 0 : 300), activeForm: `Doing ${n}`, status: n < 1 ? "completed" : n === 1 ? "in_progress" : "pending", id: `t${n}` }));
  const log = [ev(1, { type: "agent.message", text: "", toolCalls: [{ id: "p", name: "TodoWrite", arguments: JSON.stringify({ todos }) }, { id: "q", name: "update_plan", arguments: JSON.stringify({ explanation: "x".repeat(400), plan: [{ step: "One", status: "completed" }, { step: "Two", status: "in_progress" }] }) }] })];
  const [m] = phoneLog(log);
  assert.ok(m.body.type === "agent.message");
  const a = JSON.parse(m.body.toolCalls[0].arguments).todos;
  assert.deepEqual(a.map((t: any) => t.status), ["completed", "in_progress", "pending", "pending"]);
  assert.equal(a[1].content, "Fix the rounding");
  assert.equal(a[1].activeForm, "Doing 1");
  assert.equal(a[0].content.length, 120);
  assert.deepEqual(JSON.parse(m.body.toolCalls[1].arguments).todos.map((t: any) => t.content), ["One", "Two"]);
});
