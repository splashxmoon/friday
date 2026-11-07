// Agents' huddles (Huddle.tsx): which messages fold into one card, and where that card sits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { huddlesIn } from "../src/client/Huddle.js";
import type { EventBody, SessionEvent } from "../src/types.js";

let seq = 0;
const ev = (body: Partial<EventBody> & { type: string }, lane?: string, human = false): SessionEvent =>
  ({ seq: ++seq, ts: seq * 1000, actor: human ? { id: "ada", name: "Ada", kind: "human" } : { id: "engine:x", name: "Agent", kind: "agent" }, body: body as EventBody, ...(lane ? { lane } : {}) }) as SessionEvent;
const note = (from: string, to: string, kind = "tell", extra: Record<string, unknown> = {}) =>
  ev({ type: "instruction", text: `${from} to ${to}`, mesh: { id: `m${seq + 1}`, kind, fromLane: from, fromName: from, toName: to, hop: 1, by: null, ...extra } } as never, to === "main" ? undefined : to);
const person = (text: string) => ev({ type: "instruction", text } as never, undefined, true);
const all = () => true;

test("two agents' messages either way fold into one huddle, drawn at the latest", () => {
  seq = 0;
  const a = note("codex", "cursor");
  const b = note("cursor", "codex", "ask");
  const other = note("main", "gemini", "task");
  const h = huddlesIn([a, b, other], all);
  assert.equal(h.get(a.seq), h.get(b.seq), "both ways are one conversation");
  assert.equal(h.get(a.seq)!.anchor, b.seq);
  assert.deepEqual(h.get(a.seq)!.evs.map((e) => e.seq), [a.seq, b.seq]);
  assert.notEqual(h.get(other.seq), h.get(a.seq), "another pair is another huddle");
  assert.equal(h.get(other.seq)!.anchor, other.seq);
});

test("a person's message starts new huddles; a message to the whole team keeps its own card", () => {
  seq = 0;
  const a = note("codex", "cursor");
  const p = person("Now the receipts");
  const b = note("cursor", "codex");
  const team = note("main", "codex", "tell", { team: "t1" });
  const h = huddlesIn([a, p, b, team], all);
  assert.notEqual(h.get(a.seq), h.get(b.seq));
  assert.equal(h.get(a.seq)!.anchor, a.seq);
  assert.equal(h.get(team.seq), undefined);
});

test("only what is on screen folds: looking at one agent, the other's side doesn't hide its card", () => {
  seq = 0;
  const toCursor = note("codex", "cursor");
  const toCodex = note("cursor", "codex");
  const h = huddlesIn([toCursor, toCodex], (e) => (e.lane ?? "main") === "cursor");
  assert.equal(h.get(toCursor.seq)!.anchor, toCursor.seq, "the card sits on the message that is shown");
  assert.equal(h.get(toCodex.seq), undefined);
});
