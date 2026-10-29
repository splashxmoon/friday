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

test("an agent out of usage whose work another agent carried on isn't a red 'stopped' (Arun, 2026-10-28: \"iron everything\")", () => {
  const rows: [EventBody, string?][] = [
    [{ type: "session.created", title: "t", ownerId: "u", ownerName: "Ada" } as EventBody],
    [lane("lx", "Codex")], [engine("codex"), "lx"],
    [lane("lc", "Claude Code")], [engine("claude"), "lc"],
    [{ type: "run.started", causedBy: 1 } as EventBody, "lc"],
    [{ type: "run.ended", outcome: "error", error: "5-hour limit reached ∙ resets 3pm" } as EventBody, "lc"],
  ];
  assert.equal(crewOf(project("s", log(rows)))!.agents.find((a) => a.lane === "lc")!.state, "failed", "nobody has its work");
  const carried = crewOf(project("s", log([...rows, [{ type: "run.started", causedBy: 1 } as EventBody, "lx"], [{ type: "run.ended", outcome: "done" } as EventBody, "lx"]])))!;
  assert.deepEqual(carried.agents.filter((a) => a.lane !== "main").map((a) => [a.name, a.state]), [["Codex", "done"], ["Claude Code", "idle"]]);
});

test("an agent that finished with its plan short says where it stopped, not done (QA, 2026-10-28: \"Claude Code · done\" over 3 of 5)", () => {
  const todo = (statuses: string[]) => ({ type: "agent.message", text: "plan", toolCalls: [{ id: "t", name: "TodoWrite", arguments: JSON.stringify({ todos: statuses.map((status, i) => ({ content: `step ${i}`, status })) }) }] }) as EventBody;
  const rows: [EventBody, string?][] = [
    [{ type: "session.created", title: "t", ownerId: "u", ownerName: "Ada" } as EventBody],
    [lane("lc", "Claude Code")], [engine("claude"), "lc"],
    [{ type: "run.started", causedBy: 1 } as EventBody, "lc"],
    [todo(["completed", "completed", "completed", "in_progress", "pending"]), "lc"],
    [{ type: "run.ended", outcome: "done" } as EventBody, "lc"],
  ];
  const a = crewOf(project("s", log(rows)))!.agents.find((x) => x.lane === "lc")!;
  assert.deepEqual([a.state, a.plan], ["short", "3 of 5"]);
  const all = crewOf(project("s", log([...rows.slice(0, 4), [todo(["completed", "completed", "cancelled"]), "lc"], rows[5]!])))!.agents.find((x) => x.lane === "lc")!;
  assert.deepEqual([all.state, all.plan], ["done", undefined]);
});

test("an agent somebody stopped reads stopped, not done, until its next turn (2026-10-28 QA: \"Claude Code · done\" after Stop)", () => {
  const rows: [EventBody, string?][] = [
    [{ type: "session.created", title: "t", ownerId: "u", ownerName: "Ada" } as EventBody],
    [lane("lc", "Claude Code")], [engine("claude"), "lc"],
    [{ type: "run.started", causedBy: 1 } as EventBody, "lc"],
    [{ type: "run.pause" } as EventBody, "lc"],
    [{ type: "run.ended", outcome: "done" } as EventBody, "lc"],
  ];
  assert.equal(crewOf(project("s", log(rows)))!.agents[0]!.state, "stopped");
  rows.push([{ type: "run.started", causedBy: 1 } as EventBody, "lc"], [{ type: "run.ended", outcome: "done" } as EventBody, "lc"]);
  assert.equal(crewOf(project("s", log(rows)))!.agents[0]!.state, "done");
});
