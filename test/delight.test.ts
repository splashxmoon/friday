import assert from "node:assert/strict";
import test from "node:test";
import { badgeFavicon, recapStats, tabStatus } from "../src/session-line.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/**
 * The tab says how the session is doing, and the session ends on a card with its numbers.
 */

const t0 = 1_700_000_000_000;
const build = (bodies: [EventBody, "human" | "agent"][], from = 0): SessionEvent[] =>
  bodies.map(([body, kind], i) => ({ seq: from + i + 1, ts: t0 + (from + i) * 3600_000, actor: kind === "human" ? { id: "Priya", name: "Priya", kind } : { id: "engine:x", name: "Friday Code", kind }, body }));
const created: EventBody = { type: "session.created", title: "x", ownerId: "Priya", ownerName: "Priya", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody;

test("the tab's dot: amber when you are needed, violet while an agent works, green after a run finished well, none otherwise", () => {
  const working = build([[created, "human"], [{ type: "instruction", text: "Go.", interrupt: false }, "human"], [{ type: "run.started", causedBy: 2 }, "agent"]]);
  assert.equal(tabStatus(project("s", working), working, 0), "working");
  assert.equal(tabStatus(project("s", working), working, 2), "needs-you", "being needed outranks the work");
  const done = [...working, ...build([[{ type: "agent.message", text: "Done.", toolCalls: [], tokens: 1200 }, "agent"], [{ type: "run.ended", outcome: "done" }, "agent"]], working.length)];
  assert.equal(tabStatus(project("s", done), done, 0), "done");
  const failed = done.map((e) => (e.body.type === "run.ended" ? { ...e, body: { type: "run.ended" as const, outcome: "error" as const, error: "boom" } } : e));
  assert.equal(tabStatus(project("s", failed), failed, 0), null);
  const fresh = build([[created, "human"]]);
  assert.equal(tabStatus(project("s", fresh), fresh, 0), null);
});

test("the dot goes into the icon's corner and nowhere else", () => {
  const out = badgeFavicon(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="91 0 60 60"><path d="M1 1"/></svg>\n`, "#4fd1a1");
  assert.match(out, /<path d="M1 1"\/><circle cx="143" cy="51" r="8.5" fill="#4fd1a1"[^>]*\/><\/svg>$/);
  assert.equal(out.split("<circle").length, 2);
});

test("the recap counts days from the first message, runs, people and tokens, and leaves out what is zero", () => {
  const ev = build([
    [created, "human"],
    [{ type: "instruction", text: "Go.", interrupt: false }, "human"],
    [{ type: "run.started", causedBy: 2 }, "agent"],
    [{ type: "agent.message", text: "Done.", toolCalls: [], tokens: 48_200 }, "agent"],
    [{ type: "run.ended", outcome: "done" }, "agent"],
    [{ type: "run.started", causedBy: 2 }, "agent"],
    [{ type: "run.ended", outcome: "done" }, "agent"],
  ]);
  assert.deepEqual(recapStats(ev, t0 + 3600_000 + 2 * 86_400_000), ["2 days from the first message", "2 runs", "48k tokens"]);
  assert.deepEqual(recapStats(build([[created, "human"]]), t0), ["0 runs"]);
});
