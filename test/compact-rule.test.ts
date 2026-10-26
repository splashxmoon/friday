import assert from "node:assert/strict";
import test from "node:test";
import { compactAt, shouldCompact } from "../src/engine/hub.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/** When Friday has a coding tool compact its conversation before a turn (Arun, 2026-10-24: "optimizing token spends"). */

const ev = (seq: number, body: object, lane?: string) => ({ seq, ts: seq, actor: { id: "a", name: "A", kind: "agent" }, body: body as EventBody, ...(lane ? { lane } : {}) }) as SessionEvent;
const usage = (context: number, window = 1_000_000, tool = "claude") => ({ type: "agent.usage", tool, input: 1, cached: 1, output: 1, context, window });

test("past the limit, by its own tool, on its own lane, and once until it grows again", () => {
  assert.equal(compactAt(1_000_000), 200_000);
  assert.equal(compactAt(200_000), 100_000, "a small window: at half of it");
  assert.deepEqual(shouldCompact([ev(1, usage(430_000))], "main", "claude"), { before: 430_000, window: 1_000_000 });
  assert.equal(shouldCompact([ev(1, usage(120_000))], "main", "claude"), null, "under it");
  assert.equal(shouldCompact([ev(1, usage(430_000))], "main", "opencode"), null, "a tool Friday can't compact headless");
  assert.equal(shouldCompact([ev(1, usage(430_000, 1_000_000, "codex"))], "main", "claude"), null, "another tool's size");
  assert.equal(shouldCompact([ev(1, usage(430_000), "l2")], "main", "claude"), null, "another lane's");
  assert.equal(shouldCompact([ev(1, usage(430_000)), ev(2, { type: "context.compacted", tool: "claude", before: 430_000 })], "main", "claude"), null, "already done");
  assert.ok(shouldCompact([ev(1, usage(430_000)), ev(2, { type: "context.compacted", tool: "claude", before: 430_000 }), ev(3, usage(260_000))], "main", "claude"), "grown past it again");
  const was = process.env.FRIDAY_COMPACT_AT;
  process.env.FRIDAY_COMPACT_AT = "0";
  assert.equal(shouldCompact([ev(1, usage(900_000))], "main", "claude"), null, "turned off");
  if (was === undefined) delete process.env.FRIDAY_COMPACT_AT;
  else process.env.FRIDAY_COMPACT_AT = was;
});
