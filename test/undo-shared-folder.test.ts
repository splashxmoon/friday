// Undo where agents share a folder, and what a checkpoint leaves out (Arun, 2026-10-28: "iron everything and ensure we are
// good… any logic errors"). An undo compares the folder with a checkpoint and puts back every difference: another agent's work
// in the same folder at the same time would go with it, and a file a checkpoint never held could be deleted for good.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sharedWorkDuring } from "../src/rewind.js";
import { checkpoint, ignoreLine, leftOut, restore } from "../src/runner/git.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const ev = (seq: number, body: EventBody, lane?: string): SessionEvent => ({ seq, ts: seq * 1000, actor: { id: "u", name: "U" } as SessionEvent["actor"], body, ...(lane ? { lane } : {}) });
const sha = (c: string) => c.repeat(40);

test("an undo is refused when another agent in the same folder worked while the run did", () => {
  const log = [
    ev(1, { type: "run.started", causedBy: 0, checkpoint: sha("a") }),
    ev(2, { type: "run.started", causedBy: 0 }, "codex"),
    ev(3, { type: "run.ended", outcome: "done" }, "codex"),
    ev(4, { type: "run.ended", outcome: "done", after: sha("b") }),
  ];
  assert.equal(sharedWorkDuring(log, "main", sha("a"), new Set(["codex"]), true), true, "its picture, made meanwhile, would be deleted");
  assert.equal(sharedWorkDuring(log, "main", sha("a"), new Set(), true), false, "nobody shares the folder");

  // The other agent worked only before the run, or only after it: a bounded undo touches none of it.
  const apart = [
    ev(1, { type: "run.started", causedBy: 0 }, "codex"),
    ev(2, { type: "run.ended", outcome: "done" }, "codex"),
    ev(3, { type: "run.started", causedBy: 0, checkpoint: sha("a") }),
    ev(4, { type: "run.ended", outcome: "done", after: sha("b") }),
    ev(5, { type: "run.started", causedBy: 0 }, "codex"),
    ev(6, { type: "run.ended", outcome: "done" }, "codex"),
  ];
  assert.equal(sharedWorkDuring(apart, "main", sha("a"), new Set(["codex"]), true), false);
  // Unbounded (no saved end, or a rewind of everything since): its later work would go too.
  assert.equal(sharedWorkDuring(apart, "main", sha("a"), new Set(["codex"]), false), true);

  // Still running when the run began.
  const over = [ev(1, { type: "run.started", causedBy: 0 }, "codex"), ev(2, { type: "run.started", causedBy: 0, checkpoint: sha("a") }), ev(3, { type: "run.ended", outcome: "done", after: sha("b") })];
  assert.equal(sharedWorkDuring(over, "main", sha("a"), new Set(["codex"]), true), true);
  // A checkpoint nobody can place in time is not risked.
  assert.equal(sharedWorkDuring(over, "main", sha("f"), new Set(["codex"]), true), true);
  // A redo, bounded by where its undo left the folder: only that moment.
  const redo = [...apart, ev(7, { type: "folder.restored", sha: sha("a"), undo: sha("c"), restored: 1, removed: 0, after: sha("d") })];
  assert.equal(sharedWorkDuring(redo, "main", sha("c"), new Set(["codex"]), true), false);
});

test("a checkpoint leaves big files and pictures out, and an undo never deletes or writes over what it didn't keep", async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), "friday-leftout-"));
  t.after(() => rm(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "init");

  // The rules, alone: a picture over a megabyte, anything over the size limit, the largest past the total.
  const mb = 1024 * 1024;
  assert.deepEqual([...leftOut([{ path: "icon.png", size: 4000 }, { path: "render.mp4", size: 2 * mb }, { path: "data.bin", size: 30 * mb }, { path: "a.txt", size: 10 }])].sort(), ["data.bin", "render.mp4"]);
  assert.deepEqual([...leftOut([{ path: "x", size: 6 }, { path: "y", size: 5 }], { media: 1, file: 100, bytes: 6 })], ["x"], "past the total, the largest first");
  assert.equal(ignoreLine("frames/f [1]*.png"), "/frames/f \\[1]\\*.png");
  assert.equal(ignoreLine("odd "), "/odd\\ ");
  assert.equal(ignoreLine("a\nb"), null);

  // In a real folder: the render isn't in the checkpoint, the icon is.
  const big = Buffer.alloc(2 * mb, 1);
  await writeFile(path.join(repo, "render.mp4"), big);
  await writeFile(path.join(repo, "icon.png"), "png");
  const start = await checkpoint(repo, "run");
  const held = g("ls-tree", "-r", "--name-only", start!).split("\n");
  assert.ok(held.includes("icon.png"));
  assert.ok(!held.includes("render.mp4"), "the render isn't copied into git");

  // The run makes a note and a new render; undo removes the note, and leaves both renders, whose bytes nothing kept.
  await writeFile(path.join(repo, "note.md"), "made by the run\n");
  await writeFile(path.join(repo, "cut-final.mov"), big);
  const r = await restore(repo, start!);
  const there = (f: string) => stat(path.join(repo, f)).then(() => true, () => false);
  assert.equal(await there("note.md"), false);
  assert.equal(await there("render.mp4"), true);
  assert.equal(await there("cut-final.mov"), true);
  assert.equal(r.removed, 1);

  // A small file the checkpoint held, grown past the limit since: not written back over with its old bytes.
  await writeFile(path.join(repo, "notes.txt"), "small\n");
  const before = await checkpoint(repo, "run 2");
  await writeFile(path.join(repo, "notes.txt"), Buffer.alloc(26 * mb, 2));
  await restore(repo, before!);
  assert.equal((await stat(path.join(repo, "notes.txt"))).size, 26 * mb, "its new bytes stay");
});
