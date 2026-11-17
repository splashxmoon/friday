import assert from "node:assert/strict";
import test from "node:test";
import { startOf, whyRun } from "../src/run-why.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/** Why a run started, said on it in its chat and in its Spend (run-why.ts). */
let seq = 0;
const ev = (body: EventBody, actor: SessionEvent["actor"], lane = "k"): SessionEvent => ({ seq: ++seq, ts: seq, actor, body, lane });
const ada = { id: "ada", name: "Ada Lovelace", kind: "human" as const };
const friday = { id: "friday", name: "Friday", kind: "system" as const };
const sage = { id: "engine:local", name: "Sage", kind: "agent" as const };
const ask = (text: string, actor: SessionEvent["actor"], more: Record<string, unknown> = {}) => ev({ type: "instruction", text, interrupt: false, ...more } as EventBody, actor);
const run = (i: SessionEvent) => ev({ type: "run.started", causedBy: i.seq }, sage);

test("why each run started: a person, a crew mate, a routine, a wake, Friday", () => {
  const events: SessionEvent[] = [];
  const push = (...e: SessionEvent[]) => (events.push(...e), e.at(-1)!);
  const a = push(ask("Fix it", ada));
  const r1 = push(run(a));
  assert.deepEqual(whyRun(events, r1, "ada"), { kind: "asked", label: "You asked" });
  assert.deepEqual(whyRun(events, r1, "someone"), { kind: "asked", label: "Ada asked" });
  const m = push(ask("Check the table", sage, { mesh: { id: "m", kind: "tell", fromLane: "s", fromName: "Sage", toName: "Ivy" } }));
  assert.deepEqual(whyRun(events, push(run(m))), { kind: "mate", label: "From Sage" });
  const c = push(ask('[Check-in] Look at new issues\n\n(Your every day at 09:00 routine, "Stand-up", set by the person.)', friday));
  assert.deepEqual(whyRun(events, push(run(c))), { kind: "routine", label: "Routine · Stand-up" });
  push(ev({ type: "wake.fired", id: "w", why: "PR #12 was merged" }, friday));
  const w = push(ask("[Friday] What you waited on happened.", friday));
  assert.deepEqual(whyRun(events, push(run(w))), { kind: "wake", label: "Woke: PR #12 was merged" });
  const n = push(ask("[Friday] Nothing has happened on your turn for 13 minutes.", friday));
  assert.deepEqual(whyRun(events, push(run(n))), { kind: "friday", label: "Friday nudged it" });
  const msg = push(ev({ type: "agent.message", text: "On it", toolCalls: [] }, sage));
  assert.equal(startOf(events, "k", msg.seq)?.seq, msg.seq - 1, "a block's run is the last start before it on its lane");
  assert.equal(startOf(events, "other", msg.seq), undefined);
});
