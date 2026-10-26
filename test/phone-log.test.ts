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
