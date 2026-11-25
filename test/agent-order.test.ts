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

test("finishingOrder in one pass each way puts every item where looking for each one's run from the start did (spec 13)", () => {
  /** As it was: each message's next run and each card's last run looked for across the whole list. */
  const before = <T,>(items: T[], info: (t: T) => OrderInfo, last: (t: T) => number, working: ReadonlySet<string>): T[] => {
    const infos = items.map(info);
    const place = new Array<number>(items.length);
    infos.forEach((x, i) => {
      if (x.kind === "other") place[i] = x.seq;
      else if (x.kind === "run") place[i] = x.ended ?? (x.live ? Infinity : last(items[i]!));
    });
    infos.forEach((x, i) => {
      if (x.kind !== "ask") return;
      const next = infos.findIndex((y, j) => j > i && y.kind === "run" && y.lane === x.lane);
      place[i] = next !== -1 ? place[next]! : working.has(x.lane) ? Infinity : x.seq;
    });
    infos.forEach((x, i) => {
      if (x.kind !== "after") return;
      const run = infos.findLastIndex((y, j) => j < i && y.kind === "run" && y.lane === x.lane);
      place[i] = run !== -1 ? place[run]! : x.seq;
    });
    return items.map((it, i) => ({ it, i, at: place[i]! })).sort((a, b) => (a.at === b.at ? a.i - b.i : a.at - b.at)).map((x) => x.it);
  };
  let seed = 5;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 300; round++) {
    const infos: OrderInfo[] = Array.from({ length: 1 + rnd(40) }, (_, i) => {
      const lane = "abc"[rnd(3)]!;
      const k = rnd(4);
      return k === 0 ? { kind: "run", lane, ...(rnd(2) ? { ended: i * 2 + rnd(9) } : {}), live: !!rnd(2) } : k === 1 ? { kind: "ask", lane, seq: i * 2 } : k === 2 ? { kind: "after", lane, seq: i * 2 } : { kind: "other", seq: i * 2 };
    });
    const ids = infos.map((_, i) => i);
    const working = new Set(rnd(2) ? ["a"] : []);
    assert.deepEqual(finishingOrder(ids, (i) => infos[i]!, (i) => i * 2 + 1, working), before(ids, (i) => infos[i]!, (i) => i * 2 + 1, working), `round ${round}`);
  }
});
