import assert from "node:assert/strict";
import test from "node:test";
import { finishingOrder, heldOrder, type OrderInfo } from "../src/client/agent-order.js";

/** The "All agents" feed: a turn that has finished settles above the agents still working, which stay at the bottom. */

type Item = { name: string; info: OrderInfo; last?: number };
const order = (items: Item[], working: string[]) => finishingOrder(items, (x) => x.info, (x) => x.last ?? 0, new Set(working)).map((x) => x.name);

test("the agent that just finished moves above the one still working", () => {
  const items: Item[] = [
    { name: "ask reviewer", info: { kind: "ask", lane: "rev", seq: 1 } },
    { name: "ask claude", info: { kind: "ask", lane: "main", seq: 2 } },
    { name: "reviewer run", info: { kind: "run", lane: "rev", live: true } },
    { name: "claude run", info: { kind: "run", lane: "main", ended: 9, live: false } },
  ];
  assert.deepEqual(order(items, ["rev"]), ["ask claude", "claude run", "ask reviewer", "reviewer run"]);
});

test("when the last one finishes nothing moves back", () => {
  const items: Item[] = [
    { name: "ask reviewer", info: { kind: "ask", lane: "rev", seq: 1 } },
    { name: "ask claude", info: { kind: "ask", lane: "main", seq: 2 } },
    { name: "reviewer run", info: { kind: "run", lane: "rev", ended: 20, live: false } },
    { name: "claude run", info: { kind: "run", lane: "main", ended: 9, live: false } },
  ];
  assert.deepEqual(order(items, []), ["ask claude", "claude run", "ask reviewer", "reviewer run"]);
});

test("notes and the room's chat keep their place, and one agent's feed is the log's order", () => {
  const items: Item[] = [
    { name: "note", info: { kind: "other", seq: 1 } },
    { name: "ask", info: { kind: "ask", lane: "main", seq: 2 } },
    { name: "run", info: { kind: "run", lane: "main", ended: 6, live: false } },
    { name: "chat", info: { kind: "other", seq: 7 } },
    { name: "ask again", info: { kind: "ask", lane: "main", seq: 8 } },
    { name: "run again", info: { kind: "run", lane: "main", live: true } },
  ];
  assert.deepEqual(order(items, ["main"]), ["note", "ask", "run", "chat", "ask again", "run again"]);
});

test("a message queued for a working agent waits at the bottom with it; a run closed early stays where it stood", () => {
  const items: Item[] = [
    { name: "first run", info: { kind: "run", lane: "rev", live: false }, last: 3 },
    { name: "queued", info: { kind: "ask", lane: "rev", seq: 4 } },
    { name: "other run", info: { kind: "run", lane: "main", ended: 5, live: false } },
  ];
  assert.deepEqual(order(items, ["rev"]), ["first run", "other run", "queued"]);
});

test("while reading further up, what was shown stays as it was and anything new goes after it", () => {
  assert.deepEqual(heldOrder(["a", "b", "c"], ["b", "a", "c", "d"]), ["a", "b", "c", "d"]);
  assert.deepEqual(heldOrder(["a", "b", "c"], ["c", "a"]), ["a", "c"]);
});

test("a permission card goes with the run that asked, under it, not above the message that set it going", () => {
  const items: Item[] = [
    { name: "ask claude", info: { kind: "ask", lane: "main", seq: 8 } },
    { name: "claude run", info: { kind: "run", lane: "main", live: true } },
    { name: "claude asks", info: { kind: "after", lane: "main", seq: 15 } },
    { name: "codex note", info: { kind: "other", seq: 16 } },
  ];
  assert.deepEqual(order(items, ["main"]), ["codex note", "ask claude", "claude run", "claude asks"]);
  // One with no run before it keeps its place.
  assert.deepEqual(order([{ name: "lone", info: { kind: "after", lane: "x", seq: 3 } }, { name: "note", info: { kind: "other", seq: 4 } }], []), ["lone", "note"]);
});
