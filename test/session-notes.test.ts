import assert from "node:assert/strict";
import test from "node:test";
import { hiddenNotes } from "../src/session-notes.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/** The session notes the feed leaves out (session-notes.ts): the log keeps them all. */
let seq = 0;
const ada = { id: "ada", name: "Ada", kind: "human" as const };
const bea = { id: "bea", name: "Bea", kind: "human" as const };
const tool = { id: "engine:claude", name: "Ada's Claude Code", kind: "agent" as const };
const ev = (body: EventBody, actor: SessionEvent["actor"] = ada, lane?: string): SessionEvent => ({ seq: ++seq, ts: seq, actor, body, ...(lane ? { lane } : {}) });
const engine = (over: Record<string, unknown> = {}) => ({ type: "engine.attached", engine: { tool: "claude", hostId: "ada", hostName: "Ada", cwd: "/w", mode: "edits", ...over } }) as EventBody;

test("an agent that dropped off and came back, connecting again as it was, says nothing; a change or a lasting absence does", () => {
  seq = 0;
  const events = [
    ev(engine(), tool), // 1 first connection: shown
    ev({ type: "engine.detached", reason: "disconnected", tool: "claude" } as EventBody, tool), // 2 back at 3: hidden
    ev(engine(), tool), // 3 the same again: hidden
    ev(engine({ mode: "auto" }), tool), // 4 a different mode: shown
    ev({ type: "engine.detached", reason: "disconnected", tool: "claude" } as EventBody, tool), // 5 still away: shown
  ];
  assert.deepEqual([...hiddenNotes(events, "ada", false)].sort(), [2, 3]);
});

test("each lane on its own, and a note that says something of its own stays", () => {
  seq = 0;
  const events = [
    ev(engine(), tool),
    ev(engine({ tool: "codex" }), tool, "l2"), // another lane's first: shown
    ev({ ...(engine() as object), effortReset: true } as EventBody, tool), // dropped someone's effort: shown
    ev({ type: "engine.expected", tool: "codex", hostId: "ada", hostName: "Ada" } as EventBody, ada, "l3"), // 4 then connects: hidden
    ev(engine({ tool: "codex" }), tool, "l3"),
  ];
  assert.deepEqual([...hiddenNotes(events, "ada", false)], [4]);
});

test("you starting and joining, the wheel on Solo, a driver dropping off and taking it straight back, links and repeat joins", () => {
  seq = 0;
  const events = [
    ev({ type: "session.created", title: "t", ownerId: "ada", ownerName: "Ada", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody), // 1
    ev({ type: "member.joined", role: "owner" } as EventBody), // 2 you
    ev({ type: "member.joined", role: "editor" } as EventBody, bea), // 3 shown
    ev({ type: "member.joined", role: "editor" } as EventBody, bea), // 4 again
    ev({ type: "control.released", from: "bea", reason: "disconnect" } as EventBody, bea), // 5
    ev({ type: "control.granted", to: "bea", toName: "Bea", reason: "claim" } as EventBody, bea), // 6
    ev({ type: "link.updated", role: "editor", enabled: true, version: 2 } as EventBody), // 7 replaced by 8
    ev({ type: "link.updated", role: "editor", enabled: true, version: 3 } as EventBody), // 8 shown
    ev({ type: "control.granted", to: "ada", toName: "Ada", reason: "yield" } as EventBody, bea), // 9 a real handover: shown on Team
  ];
  assert.deepEqual([...hiddenNotes(events, "ada", false)].sort((a, b) => a - b), [1, 2, 4, 5, 6, 7]);
  assert.ok(hiddenNotes(events, "ada", true).has(9), "on Solo the wheel never says anything");
  assert.ok(!hiddenNotes(events, "bea", false).has(1), "somebody else sees who started it");
});
