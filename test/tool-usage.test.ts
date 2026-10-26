import assert from "node:assert/strict";
import { test } from "node:test";
import { lastRunStart, shortTokens, spentBefore, tokensIn } from "../src/tool-usage.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/** What "tokens saved" is counted from: the work an agent was handed, as the log counted it. */

const claude = { id: "engine:u", name: "Ada's Claude Code", kind: "agent" as const };
const friday = { id: "agent", name: "Friday Code", kind: "agent" as const };
const ev = (seq: number, actor: typeof claude, body: EventBody, lane?: string) => ({ seq, ts: seq, actor, body, ...(lane ? { lane } : {}) }) as SessionEvent;
const usage = (n: number): EventBody => ({ type: "agent.usage", tool: "claude", input: n, cached: 99_999, output: 0 });

test("a hand-off carries the work of the run it came from, counted from the tools' usage (not their cache reads) and Friday's steps, not the lane's whole past", () => {
  const log = [
    ev(1, claude, { type: "run.started", causedBy: 0 }, "l1"),
    ev(2, claude, usage(5000), "l1"),
    ev(3, claude, { type: "run.ended", outcome: "done" }, "l1"),
    ev(4, claude, { type: "run.started", causedBy: 0 }, "l1"),
    ev(5, claude, usage(1200), "l1"),
    ev(6, claude, usage(800), "l1"),
    ev(7, friday, { type: "agent.message", text: "", toolCalls: [], tokens: 9999 }),
    ev(8, friday, { type: "instruction", text: "take it", interrupt: false }),
  ];
  const from = lastRunStart(log, "l1", 8);
  assert.equal(from, 4, "the lane's latest run");
  assert.deepEqual(spentBefore(log, 8, (e) => e.seq > from && (e.lane ?? "main") === "l1"), { tokens: 2000, by: ["Ada's Claude Code"] });
  // A catch-up: everything counted before it, Friday's own steps included.
  assert.deepEqual(spentBefore(log, 8, () => true), { tokens: 16999, by: ["Ada's Claude Code", "Friday Code"] });
});

test("token counts read as people say them, and text is about four characters a token", () => {
  assert.deepEqual([950, 1240, 48_000, 2_100_000].map(shortTokens), ["950", "1.2k", "48k", "2.1M"]);
  assert.equal(tokensIn("x".repeat(4001)), 1001);
});
