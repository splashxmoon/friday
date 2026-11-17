import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { roomBrief } from "../src/room-brief.js";
import type { SessionState } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/** A room's work, whole, to carry on elsewhere (room-brief.ts). */
let seq = 0;
const ev = (body: EventBody, lane: string, name = "Sage"): SessionEvent => ({ seq: ++seq, ts: Date.UTC(2026, 10, 15, 21, seq), actor: { id: "engine:local", name, kind: "agent" }, body, lane });

test("a room's brief: its goal, who, its board, what each found with its files, who is still at it, and the crew's words", () => {
  const events = [
    ev({ type: "run.started", causedBy: 0 }, "S"),
    ev({ type: "agent.message", text: "", toolCalls: [{ id: "w", name: "write", arguments: JSON.stringify({ path: "/h/Sage/pricing.md" }) }] }, "S"),
    ev({ type: "agent.message", text: "Two of five raised prices; the table is in pricing.md.", toolCalls: [] }, "S"),
    ev({ type: "run.ended", outcome: "done" }, "S"),
    ev({ type: "instruction", text: "Ivy, Linear is $10 now.", interrupt: false, mesh: { id: "m", kind: "tell", fromLane: "S", fromName: "Sage", toName: "Ivy" } } as EventBody, "I"),
  ];
  const state = { engines: { N: { cwd: "/w/shop" } }, diffs: { N: { files: [{ path: "copy/announce.md" }] } }, laneRuns: { I: { status: "running" } }, board: { tasks: [{ title: "Price table", status: "done", name: "Sage" }, { title: "Announcement", status: "claimed", name: "Nova" }, { title: "Old", status: "cancelled" }] } } as unknown as SessionState;
  const b = roomBrief({ name: "Launch", purpose: "Ship 1.0", goal: "Launch on Tuesday", members: [{ name: "Sage", lane: "S", lead: true }, { name: "Nova", lane: "N", lead: false }, { name: "Ivy", lane: "I", lead: false }], state, events });
  assert.match(b, /^\[From the room "Launch"\]/);
  assert.match(b, /Its goal: Launch on Tuesday/);
  assert.match(b, /Who worked there: Sage \(lead\), Nova, Ivy\./);
  assert.match(b, /Its board, 1 of 2 done:\n- \[done\] Price table \(Sage\)\n- \[claimed\] Announcement \(Nova\)/);
  assert.match(b, /Sage \(finished [^)]+\):\nTwo of five raised prices/);
  assert.match(b, /Files: `\/h\/Sage\/pricing.md`/);
  assert.ok(b.includes(`Nova:\nFiles: \`${path.join("/w/shop", "copy/announce.md")}\``), "a file of its folder's diff, as a whole path");
  assert.match(b, /Ivy:\nStill at work there now\./);
  assert.match(b, /- Sage to Ivy: Ivy, Linear is \$10 now\./);
});

test("a room with nothing finished says so", () => {
  const b = roomBrief({ name: "Empty", members: [{ name: "Kit", lane: "K", lead: true }], state: { engines: {}, diffs: {}, laneRuns: {} } as unknown as SessionState, events: [] });
  assert.match(b, /Nothing finished yet\./);
});
