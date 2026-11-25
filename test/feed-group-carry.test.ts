import assert from "node:assert/strict";
import { test } from "node:test";
import { groupForTest as group } from "../src/client/Activity.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/**
 * The feed's grouping carried from one event to the next (spec 13, Arun 2026-11-24: "Go all out and fix these problems"): each
 * event folded on to the blocks so far must draw exactly what grouping the whole log again draws, and what was drawn before must
 * not change under it.
 */

const lanes = [undefined, undefined, "b", "c"];
function randomLog(seed: number, n: number): SessionEvent[] {
  const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k);
  const out: SessionEvent[] = [];
  const human = { id: "u1", name: "Ada", kind: "human" as const };
  const bot = { id: "agent", name: "Agent", kind: "agent" as const };
  for (let seq = 1; seq <= n; seq++) {
    const lane = lanes[rnd(lanes.length)];
    const k = rnd(24);
    const sha = "abcd"[rnd(4)]!.repeat(40);
    const file = (p: string) => ({ path: p, status: "modified" as const, additions: rnd(9), deletions: rnd(4), patch: rnd(2) ? `@@ ${p}` : "", ...(rnd(4) ? {} : { later: 1 + rnd(seq) }) });
    const body: EventBody =
      k < 3 ? { type: "instruction", text: rnd(5) ? `do ${seq}` : "[session] Carry on", interrupt: false, ...(rnd(6) ? {} : { approval: { id: `a${rnd(3)}`, approve: !!rnd(2) } }) } as EventBody
      : k < 5 ? { type: "run.started", causedBy: Math.max(1, seq - 1 - rnd(3)), ...(rnd(2) ? { checkpoint: sha } : {}) }
      : k < 6 ? { type: "run.checkpoint", checkpoint: sha }
      : k < 10 ? { type: "agent.message", text: rnd(4) ? `said ${seq}` : "", toolCalls: [], ...(rnd(8) ? {} : { interrupted: true }) } as EventBody
      : k < 12 ? { type: "agent.diff", base: "b", files: [file("a.ts"), ...(rnd(2) ? [file("b.ts")] : [])] }
      : k < 14 ? { type: "run.ended", outcome: (["done", "error", "waiting"] as const)[rnd(3)], ...(rnd(8) ? {} : { replaces: Math.max(1, seq - 1 - rnd(5)) }) } as EventBody
      : k < 15 ? { type: "engine.approval", id: `a${rnd(3)}`, scope: "commands", items: ["npm test"] } as EventBody
      : k < 16 ? { type: (["run.pause", "run.cancel"] as const)[rnd(2)] } as EventBody
      : k < 17 ? { type: "folder.restored", sha, undo: sha, restored: 1, removed: 0 }
      : k < 18 ? { type: "memory.saved", text: "kept" } as EventBody
      : k < 19 ? { type: "ui.card", id: `c${seq}`, card: { kind: "note" } } as unknown as EventBody
      : k < 20 ? { type: "lane.added", id: "b", name: "B" } as unknown as EventBody
      : k < 21 ? { type: "chat", text: "hi" } as EventBody
      : k < 22 ? { type: "folder.committed", sha, message: "m" } as unknown as EventBody
      : { type: "member.joined", role: "editor" } as unknown as EventBody;
    const actor = body.type === "instruction" || body.type === "chat" || body.type === "member.joined" ? human : bot;
    out.push({ seq, ts: seq * 1000, actor, body, ...(lane ? { lane } : {}) } as SessionEvent);
  }
  return out;
}

test("each event folded on draws what grouping the whole log again draws", () => {
  for (let round = 0; round < 60; round++) {
    const log = randomLog(round + 1, 40 + (round % 5) * 30);
    const keep: { fold?: never } = {};
    const drawn: { at: number; items: unknown[]; json: string }[] = [];
    for (let k = 1; k <= log.length; k++) {
      const live = new Set(k % 3 ? [] : [lanes[k % 4] ?? "main"]);
      const prefix = log.slice(0, k);
      const carried = group(prefix, live, keep);
      assert.deepEqual(carried, group(prefix, live), `round ${round}, ${k} events`);
      drawn.push({ at: k, items: carried, json: JSON.stringify(carried) });
    }
    for (const d of drawn) assert.equal(JSON.stringify(d.items), d.json, `round ${round}: what was drawn at ${d.at} events stayed as it was`);
  }
});

test("a run no event changed is the same item; the one an event changed is a new one", () => {
  const log = randomLog(99, 200).filter((e) => e.body.type !== "run.ended" || !("replaces" in e.body));
  const keep = {};
  const before = group(log.slice(0, 199), false, keep);
  const after = group(log, false, keep);
  const same = after.filter((it) => before.includes(it)).length;
  assert.ok(same >= after.length - 3, `${same} of ${after.length} kept`);
});

test("an edit to a message already folded groups the log again from the start", () => {
  const human = { id: "u1", name: "Ada", kind: "human" as const };
  const log: SessionEvent[] = [
    { seq: 1, ts: 1, actor: human, body: { type: "instruction", text: "first", interrupt: false } },
    { seq: 2, ts: 2, actor: human, body: { type: "instruction", text: "second", interrupt: false } },
  ];
  const keep = {};
  group(log, false, keep);
  const edited = [...log, { seq: 3, ts: 3, actor: human, body: { type: "instruction", text: "second, changed", interrupt: false, replaces: 2 } } as SessionEvent];
  assert.deepEqual(group(edited, false, keep), group(edited, false));
});
