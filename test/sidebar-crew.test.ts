import assert from "node:assert/strict";
import test from "node:test";
import { crewOf } from "../src/attention.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

// A session's row in the sidebar shows its agents and where each stands, read off its state (Arun, 2026-10-24: "instead of the
// secondary text like the most recent message maybe we add the agent status and stuff with their icons").
const log = (rows: [EventBody, string?][]): SessionEvent[] => rows.map(([body, lane], i) => ({ seq: i + 1, ts: 1000 + i, actor: { id: "u", name: "Ada", kind: "human" }, body, ...(lane ? { lane } : {}) }) as SessionEvent);
const lane = (id: string, name: string) => ({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } }) as EventBody;
const engine = (tool: string, online = true) => ({ type: "engine.attached", engine: { tool, cwd: "/w", hostId: "u", hostName: "Ada", mode: "full", online } }) as EventBody;

test("each agent with its tool and its state in a word; an empty main lane beside coding tools is no one", () => {
  const s = project("s", log([
    [{ type: "session.created", title: "t", ownerId: "u", ownerName: "Ada" } as EventBody],
    [lane("la", "Codex")], [engine("codex"), "la"],
    [lane("lb", "Gemini")], [engine("gemini"), "lb"],
    [lane("lc", "Cursor")], [engine("cursor"), "lc"],
    [{ type: "run.started", causedBy: 1 } as EventBody, "la"],
    [{ type: "run.started", causedBy: 1 } as EventBody, "lb"],
    [{ type: "run.ended", outcome: "error", error: "boom" } as EventBody, "lb"],
    [lane("ld", "Claude Code")], [engine("claude"), "ld"],
    [{ type: "run.started", causedBy: 1 } as EventBody, "ld"],
    [{ type: "run.ended", outcome: "done" } as EventBody, "ld"],
  ]));
  const crew = crewOf(s)!;
  assert.deepEqual(crew.agents.map((a) => [a.name, a.tool, a.state]), [["Codex", "codex", "working"], ["Gemini", "gemini", "failed"], ["Cursor", "cursor", "idle"], ["Claude Code", "claude", "done"]], "Cursor never ran: ready, not done");
});

test("a session with only its main agent is that agent", () => {
  const s = project("s", log([[{ type: "session.created", title: "t", ownerId: "u", ownerName: "Ada" } as EventBody]]));
  assert.equal(crewOf(s)?.agents.length, 1);
});
