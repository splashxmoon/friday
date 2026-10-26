import assert from "node:assert/strict";
import test from "node:test";
import { ALL, agentInSearch, catchUpIndex, closeColumn, dropAgent, firstUnread, fitColumns, maxColumns, pickInColumn, resizeAt, searchWithAgent, unreadByLane } from "../src/client/agentNav.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/** Getting around several agents: each one's unread work and where it starts, the split columns, the agent in the address. */
let seq = 0;
const ada = { id: "ada", name: "Ada", kind: "human" as const };
const bot = { id: "engine:x", name: "Agent", kind: "agent" as const };
const ev = (body: EventBody, lane?: string, actor: SessionEvent["actor"] = bot): SessionEvent => ({ seq: ++seq, ts: seq, actor, body, ...(lane ? { lane } : {}) });
const said = (text: string, lane?: string) => ev({ type: "agent.message", text, toolCalls: [] } as EventBody, lane);
const ended = (lane?: string) => ev({ type: "run.ended", outcome: "done" } as EventBody, lane);
const step = (lane?: string) => ev({ type: "agent.message", text: "", toolCalls: [{ id: "c", name: "read_file", arguments: "{}" }] } as EventBody, lane);

function session(): SessionEvent[] {
  seq = 0;
  return [
    said("hello"), // 1 main
    said("codex here", "codex"), // 2
    ev({ type: "instruction", text: "go", interrupt: false } as EventBody, "codex", ada), // 3
    step("codex"), // 4
    said("done the thing", "codex"), // 5
    ended("codex"), // 6
    said("main again"), // 7
    said("gemini", "gemini"), // 8
  ];
}

test("unread: what each agent said or finished since this person looked, never their own doings or bare steps", () => {
  const events = session();
  // Opened at 1, looked at codex up to 2.
  assert.deepEqual(unreadByLane(events, { codex: 2 }, 1, "ada"), { codex: 2, main: 1, gemini: 1 });
  // Looked at everything: nothing.
  assert.deepEqual(unreadByLane(events, { main: 8, codex: 8, gemini: 8 }, 1, "ada"), {});
  // Never looked at gemini on this page, which opened after it spoke: nothing to catch up on there.
  assert.deepEqual(unreadByLane(events, { codex: 8, main: 8 }, 8, "ada"), {});
});

test("catch-up opens at an agent's first unread thing, over the feed item that holds it", () => {
  const events = session();
  assert.equal(firstUnread(events, "codex", 2, "ada"), 5, "the bare step at 4 and Ada's own message at 3 are not it");
  assert.equal(firstUnread(events, "codex", 6, "ada"), null);
  assert.equal(firstUnread(events, "main", 0, "ada"), 1);
  // A run block from 3 to 6 holds the answer at 5: the line goes over the block, not after it.
  const items = [
    { lane: "main", last: 1 },
    { lane: "codex", last: 2 },
    { lane: "codex", last: 6 },
    { lane: "main", last: 7 },
  ];
  assert.equal(catchUpIndex(items, "codex", 5), 2);
  assert.equal(catchUpIndex(items, "main", 5), 3);
  assert.equal(catchUpIndex(items, "gemini", 5), -1);
});

test("columns: two on a laptop, three on a wide screen, one below", () => {
  assert.equal(maxColumns(900), 1);
  assert.equal(maxColumns(1100), 2);
  assert.equal(maxColumns(1499), 2);
  assert.equal(maxColumns(1500), 3);
});

test("an agent dropped on the chat opens beside the one in view, and beside the column it lands on", () => {
  const everyone = ["main", "codex", "gemini", "cursor"];
  assert.deepEqual(dropAgent(null, { lane: "codex", current: "main", everyone, max: 2 }), ["main", "codex"]);
  // From the overview, or dropping the agent already in view: beside the first other one.
  assert.deepEqual(dropAgent(null, { lane: "codex", current: ALL, everyone, max: 2 }), ["main", "codex"]);
  assert.deepEqual(dropAgent(null, { lane: "main", current: "main", everyone, max: 3 }), ["codex", "main"]);
  // No room for a split at all: nothing changes.
  assert.equal(dropAgent(null, { lane: "codex", current: "main", everyone, max: 1 }), null);
  // Room for a third: just after the column it was dropped on, or at the end.
  assert.deepEqual(dropAgent(["main", "codex"], { lane: "gemini", current: "main", everyone, max: 3, at: 0 }), ["main", "gemini", "codex"]);
  assert.deepEqual(dropAgent(["main", "codex"], { lane: "gemini", current: "main", everyone, max: 3 }), ["main", "codex", "gemini"]);
  // Full: in place of the column it landed on (the last when it landed on none).
  assert.deepEqual(dropAgent(["main", "codex"], { lane: "gemini", current: "main", everyone, max: 2, at: 0 }), ["gemini", "codex"]);
  assert.deepEqual(dropAgent(["main", "codex", "gemini"], { lane: "cursor", current: "main", everyone, max: 3 }), ["main", "codex", "cursor"]);
  // Already showing: stays where it is.
  const cols = ["main", "codex"];
  assert.equal(dropAgent(cols, { lane: "codex", current: "main", everyone, max: 3, at: 0 }), cols);
});

test("a column's agent changed swaps with the column already showing it; closing down to one is no split", () => {
  assert.deepEqual(pickInColumn(["a", "b", "c"], 0, "c"), ["c", "b", "a"]);
  assert.deepEqual(pickInColumn(["a", "b", "c"], 1, "d"), ["a", "d", "c"]);
  assert.deepEqual(closeColumn(["a", "b", "c"], 1), ["a", "c"]);
  assert.equal(closeColumn(["a", "b"], 0), null);
});

test("a narrower window keeps as many columns as fit, the one in use among them; agents that left go", () => {
  assert.deepEqual(fitColumns(["a", "b", "c"], 2, "c", ["a", "b", "c"]), ["a", "c"]);
  assert.deepEqual(fitColumns(["a", "b", "c"], 3, "a", ["a", "b", "c"]), ["a", "b", "c"]);
  assert.equal(fitColumns(["a", "b"], 1, "a", ["a", "b"]), null);
  assert.deepEqual(fitColumns(["a", "b", "c"], 3, "a", ["a", "c"]), ["a", "c"]);
  assert.equal(fitColumns(null, 3, "a", ["a"]), null);
});

test("dragging a grip moves only the two columns beside it, neither below the minimum", () => {
  assert.deepEqual(resizeAt([50, 50], 0, 60), [60, 40]);
  assert.deepEqual(resizeAt([50, 50], 0, 95, 25), [75, 25]);
  const three = resizeAt([30, 40, 30], 1, 50);
  assert.deepEqual(three.map((n) => Math.round(n)), [30, 20, 50]);
  assert.deepEqual(resizeAt([30, 40, 30], 1, 0).map((n) => Math.round(n)), [30, 20, 50], "not past the column before it");
});

test("the agent in the address: read only from this session's link, written without touching the rest", () => {
  assert.equal(agentInSearch("?session=s1&invite=i&agent=codex", "s1"), "codex");
  assert.equal(agentInSearch("?session=s2&invite=i&agent=codex", "s1"), null);
  assert.equal(agentInSearch("?session=s1&invite=i", "s1"), null);
  assert.equal(searchWithAgent("?session=s1&invite=i", "s1", "codex"), "?session=s1&invite=i&agent=codex");
  assert.equal(searchWithAgent("?session=s1&invite=i&agent=codex", "s1", "gemini"), "?session=s1&invite=i&agent=gemini");
  assert.equal(searchWithAgent("?session=s1&invite=i&agent=codex", "s1", ALL), "?session=s1&invite=i");
  assert.equal(searchWithAgent("?view=agents", "s1", "codex"), null);
});
