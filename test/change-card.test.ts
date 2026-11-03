// What a reply changed, under it (Arun, 2026-11-03): the card lists this turn's own files, not the folder's running total, and
// opens a few changed lines of one in place, numbered as the new file has them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { miniDiff } from "../src/client/RunReview.js";
import { turnFilesOf } from "../src/client/Activity.js";
import type { DiffFile, SessionEvent } from "../src/types.js";

const file = (path: string, patch: string, more: Partial<DiffFile> = {}): DiffFile => ({ path, status: "modified", additions: 1, deletions: 0, patch, ...more });
const diff = (seq: number, files: DiffFile[], lane = "main"): SessionEvent => ({ seq, ts: seq, actor: { id: "a", name: "Ada", kind: "agent" }, lane, body: { type: "agent.diff", files } }) as unknown as SessionEvent;

test("a turn's card has only the files it changed: one whose patch is what it was before the turn began is left off", () => {
  const before = [file("a.ts", "@@ -1 +1 @@\n-x\n+y"), file("b.ts", "@@ -1 +1 @@\n-p\n+q")];
  const events = [diff(10, before), diff(30, [file("c.ts", "@@ -0,0 +1 @@\n+z")], "other")];
  const ended = [file("a.ts", "@@ -1 +1 @@\n-x\n+y"), file("b.ts", "@@ -1 +1,2 @@\n-p\n+q\n+r", { additions: 2 }), file("c.ts", "@@ -0,0 +1 @@\n+new", { status: "added" })];
  assert.deepEqual(turnFilesOf(ended, events, "main", 20).map((f) => f.path), ["b.ts", "c.ts"], "b changed again and c is new; a is the earlier turn's");
  // The log writes a patch it has already kept as a reference to the change set that first had it.
  const kept = [file("a.ts", "", { at: 10 }), file("b.ts", "@@ -1 +1 @@\n-p\n+s")];
  assert.deepEqual(turnFilesOf(kept, events, "main", 20).map((f) => f.path), ["b.ts"]);
  assert.deepEqual(turnFilesOf(ended, [], "main", 20).length, 3, "the session's first turn: everything is its own");
  assert.deepEqual(turnFilesOf([file("a.ts", "", { additions: 0 })], events, "main", 20), [], "nothing changed, no card");
});

test("a mini diff shows the first changed lines, numbered as the new file has them, and says how many there are", () => {
  const patch = ["@@ -40,4 +40,9 @@ export async function retryPayment(order) {", " export async function retryPayment(order) {", "-  return charge(order);", "+  for (let i = 0; i < 3; i++) {", "+    const r = await charge(order);", "+    if (r.ok) return mark(order);", "+  }", " }", "@@ -90,2 +95,3 @@", " a", "+b", " c"].join("\n");
  const m = miniDiff(patch, 4);
  assert.equal(m.changed, 6);
  assert.deepEqual(
    m.lines.map((l) => [l.kind, l.n, l.text]),
    [
      ["hunk", null, "@@ export async function retryPayment(order) { @@"],
      ["del", 41, "  return charge(order);"],
      ["add", 41, "  for (let i = 0; i < 3; i++) {"],
      ["add", 42, "    const r = await charge(order);"],
      ["add", 43, "    if (r.ok) return mark(order);"],
    ],
  );
  const all = miniDiff(patch, 20);
  assert.deepEqual(all.lines.filter((l) => l.kind === "add").map((l) => l.n), [41, 42, 43, 44, 96], "the second hunk counts from its own start");
  assert.deepEqual(miniDiff("").lines, []);
});
