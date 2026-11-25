import assert from "node:assert/strict";
import { test } from "node:test";
import { groupForTest as group } from "../src/client/Activity.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/**
 * A turn cut short by a message (a wake, a hold, another agent's word) and not heard from since is the same turn carrying on: its
 * reply says the step under way, timed from the turn's start (Arun, 2026-11-24: agents twenty minutes into their work read
 * "Getting started · usually ~1 min" in the chat after a wake or a message reached them).
 */
const human = { id: "u1", name: "Ada", kind: "human" as const };
const bot = { id: "agent", name: "Claude Code 4", kind: "agent" as const };
const ev = (seq: number, body: EventBody, lane = "l4"): SessionEvent => ({ seq, ts: seq * 60_000, actor: body.type === "instruction" ? human : bot, body, lane }) as SessionEvent;

test("a working turn cut short by a message is a turn carrying on, from its own start, not one getting started", () => {
  const events = [
    ev(1, { type: "instruction", text: "Verify the tables", interrupt: false } as EventBody),
    ev(2, { type: "run.started", causedBy: 1 } as EventBody),
    ev(3, { type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "mcp__friday__browser", arguments: '{"action":"click","ref":47}' }] } as EventBody),
    ev(4, { type: "instruction", text: "[Friday] It's been 20 minutes: time to check where it stands.", interrupt: false } as EventBody),
    ev(5, { type: "instructions.delivered", seqs: [4], steer: true } as EventBody),
  ];
  const items = group(events, new Set(["l4"]));
  const last = items.at(-1) as { kind: string; lane?: string; messages?: unknown[]; carryOn?: true; startedTs?: number };
  assert.equal(last.kind, "run");
  assert.equal(last.lane, "l4");
  assert.deepEqual(last.messages, [], "nothing new said since the message");
  assert.equal(last.carryOn, true, "the turn under way, carrying on");
  assert.equal(last.startedTs, 2 * 60_000, "timed from the turn's own start");
});

test("a lane starting a fresh turn is still getting started", () => {
  const events = [ev(1, { type: "instruction", text: "Verify the tables", interrupt: false } as EventBody)];
  const last = group(events, new Set(["l4"])).at(-1) as { kind: string; carryOn?: true };
  assert.equal(last.kind, "run");
  assert.equal(last.carryOn, undefined);
});
