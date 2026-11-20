import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { absolute, filesFrom, rewindConfirm, rewoundNow, touchedDirty, turnLabel, turnsOf, turnSub } from "../src/client/ide/rewind-ide.js";
import type { EventBody, SessionEvent } from "../src/types.js";
import { internPatches, lightLog } from "../src/session/patches.js";
import { DIRTY_FRESH_MS, freshAllDirty, freshDirty, readDirty, rememberDirty, type DirtyFiles } from "../src/vscode-dirty.js";

const require = createRequire(import.meta.url);

const ev = (seq: number, body: EventBody, lane?: string, kind: "human" | "agent" = "agent"): SessionEvent => ({ seq, ts: 1_700_000_000_000 + seq * 1000, actor: { id: "u", name: "U", kind } as SessionEvent["actor"], body, ...(lane ? { lane } : {}) });
const said = (seq: number, text: string) => ev(seq, { type: "instruction", text, interrupt: false }, undefined, "human");
const sha = (c: string) => c.repeat(40);
/** A change set: the folder against where the session began, each file by the patch it has (a file edited again has a new one). */
const diff = (seq: number, files: Record<string, string>) => ev(seq, { type: "agent.diff", base: sha("0"), files: Object.entries(files).map(([path, patch]) => ({ path, status: "modified" as const, additions: 1, deletions: 0, patch })) });

/** Two turns of a coding tool, each editing a file, in a folder under git. */
function twoTurns(): SessionEvent[] {
  return [
    said(1, "Add a notes section\nplease"),
    ev(2, { type: "run.started", causedBy: 1, checkpoint: sha("a") }),
    diff(3, { "README.md": "+one" }),
    ev(4, { type: "run.ended", outcome: "done", after: sha("b") }),
    said(5, "Add a second note"),
    ev(6, { type: "run.started", causedBy: 5, checkpoint: sha("b") }),
    diff(7, { "README.md": "+one+two", "docs/a.md": "+a" }),
    ev(8, { type: "run.ended", outcome: "done" }),
  ];
}

test("the turns of a chat are the messages that have a checkpoint, newest first, with the files each changed", () => {
  const turns = turnsOf(twoTurns());
  assert.deepEqual(turns.map((t) => [t.seq, t.checkpoint, t.files]), [[5, sha("b"), 2], [1, sha("a"), 1]], "the second turn changed README.md again and added a file; the first, one");
  assert.equal(turns[1]!.text, "Add a notes section\nplease");
  assert.equal(turnLabel(turns[1]!.text), "Add a notes section", "its first line");
  assert.equal(turnLabel("x".repeat(80), 20), `${"x".repeat(19)}…`);
});

test("a message with no run after it, or from the session itself, is not a turn", () => {
  const log = [said(1, "hello"), ev(2, { type: "instruction", text: "[session] note", interrupt: false }, undefined, "human"), ev(3, { type: "run.started", causedBy: 2 })];
  assert.deepEqual(turnsOf(log), []);
});

test("the files a rewind puts back are every file changed from that message on", () => {
  const log = twoTurns();
  assert.deepEqual(filesFrom(log, 5), ["README.md", "docs/a.md"]);
  assert.deepEqual(filesFrom(log, 1), ["README.md", "docs/a.md"]);
  // A rewind said again as an empty change set, then the notes redone: the same, not the empty one.
  const redone = [...log, ev(9, { type: "folder.restored", sha: sha("a"), undo: sha("c"), restored: 2, removed: 0, whole: true }), diff(10, {}), ev(11, { type: "folder.restored", sha: sha("c"), undo: sha("d"), restored: 2, removed: 0 }), diff(12, { "README.md": "+one+two", "docs/a.md": "+a" })];
  assert.deepEqual(filesFrom(redone, 5), ["README.md", "docs/a.md"]);
  assert.deepEqual(filesFrom([...log, ev(9, { type: "folder.restored", sha: sha("a"), undo: sha("c"), restored: 2, removed: 0, whole: true }), diff(10, {})], 1), [], "nothing left to put back once the folder is at the start");
  assert.deepEqual(filesFrom([...log, ev(9, { type: "folder.edited", path: "src/x.ts", bytes: 3 })], 5), ["README.md", "docs/a.md", "src/x.ts"], "your own edits too");
});

test("a coding tool's rewind stands until the next message, and can be redone until then", () => {
  const log = [...twoTurns(), ev(9, { type: "folder.restored", sha: sha("a"), undo: sha("c"), restored: 2, removed: 1, whole: true }, undefined, "human")];
  assert.deepEqual(rewoundNow(log), { seq: 9, lane: "main", files: 3, undo: sha("c") });
  // Redone: the restore that puts back the folder as it was before the rewind.
  const redone = [...log, ev(10, { type: "folder.restored", sha: sha("c"), undo: sha("d"), restored: 3, removed: 0 })];
  assert.equal(rewoundNow(redone), null);
  // The next message ends it too.
  assert.equal(rewoundNow([...log, said(10, "try again")]), null);
});

test("Friday's own agent's rewind is said but offers no redo", () => {
  const log = [...twoTurns(), ev(9, { type: "folder.restored", sha: sha("b"), undo: sha("c"), restored: 1, removed: 0, rewoundTo: 5 })];
  assert.deepEqual(rewoundNow(log), { seq: 9, lane: "main", files: 1 });
  assert.deepEqual(turnsOf(log).map((t) => t.seq), [1], "what it set aside is not offered again");
});

test("a plain undo of a run is not a rewind", () => {
  assert.equal(rewoundNow([...twoTurns(), ev(9, { type: "folder.restored", sha: sha("b"), undo: sha("c"), restored: 1, removed: 0 })]), null);
});

test("the confirm says how many files go back, that the tool remembers, and which unsaved files stay", () => {
  const c = rewindConfirm({ files: ["README.md", "docs/a.md"], dirty: [], tool: "claude" });
  assert.equal(c.action, "Rewind to here");
  assert.match(c.body, /2 files the agent changed go back to how they were before this message/);
  assert.match(c.body, /Anything you saved yourself since goes back too/, "when the folder was not asked, it says what it does not know");
  assert.match(c.body, /Claude Code keeps its own conversation/);
  assert.match(c.body, /redo this/);
  assert.ok(!/unsaved/.test(c.body));
  assert.match(rewindConfirm({ files: ["README.md"], dirty: [], tool: "claude" }).body, /1 file the agent changed goes back to how it was/);
  assert.match(rewindConfirm({ files: [], dirty: [], tool: "claude" }).body, /^The files go back to how they were before/);
  // Asked of the folder: every file that differs goes back, and the ones the agent never touched are named as the person's own.
  const exact = rewindConfirm({ files: ["README.md", "docs/b.md"], dirty: [], tool: "claude", exact: true, mine: ["docs/b.md"] });
  assert.match(exact.body, /^2 files go back to how they were before this message was acted on\. One is yours: b\.md, which you saved since\./);
  assert.ok(!/the agent changed/.test(exact.body));
  const d = rewindConfirm({ files: ["README.md"], dirty: ["src/a.ts", "src/b.ts", "c.ts", "d.ts"], tool: "claude" });
  assert.match(d.body, /unsaved edits in a\.ts, b\.ts, c\.ts and 1 more\. They stay in the editor as they are/);
  assert.match(rewindConfirm({ files: ["a"], dirty: [] }).body, /can't be redone/);
  assert.ok(!/VS Code/.test(JSON.stringify([c, d])));
});

test("only the unsaved files a rewind touches are named; all of them when the touched files aren't known", () => {
  assert.deepEqual(touchedDirty(["/p/README.md", "/p/src/a.ts", "/p/z.ts"], ["/p/README.md", "/p/src/a.ts"]), ["/p/README.md", "/p/src/a.ts"]);
  assert.deepEqual(touchedDirty(["/p/z.ts"], ["/p/README.md"]), []);
  assert.deepEqual(touchedDirty(["/p/z.ts"], []), ["/p/z.ts"]);
  // Both sides absolute: the same relative name in another folder is not the file, and a Windows drive's case does not matter.
  assert.deepEqual(touchedDirty(["/other/README.md"], [absolute("/p", "README.md")]), []);
  assert.deepEqual(touchedDirty(["C:/Work/p/a.ts"], [absolute("c:\\work\\p", "a.ts")]), ["C:/Work/p/a.ts"]);
});

test("a turn's second line says when, and how many files", () => {
  const t = turnsOf(twoTurns())[0]!;
  assert.match(turnSub(t, t.ts + 1000), /\d.* · 2 files/);
  assert.match(turnSub({ ...t, files: 0 }, t.ts + 1000), /no files$/);
});

test("the server keeps what the IDE says is unsaved, and forgets it when the IDE goes quiet", () => {
  const d = readDirty({ root: "/p", paths: ["a.ts", "a.ts", 3, "", "b.ts"] }, 1000);
  assert.deepEqual(d, { root: "/p", paths: ["a.ts", "b.ts"], files: [], at: 1000 });
  assert.deepEqual(freshDirty(d, 1000 + DIRTY_FRESH_MS - 1).paths, ["a.ts", "b.ts"]);
  assert.deepEqual(freshDirty(d, 1000 + DIRTY_FRESH_MS), { root: "", paths: [] });
  assert.deepEqual(freshDirty(null, 5), { root: "", paths: [] });
});

test("each IDE window keeps its own unsaved list, and one that goes quiet drops out", () => {
  const all = new Map<string, DirtyFiles>();
  rememberDirty(all, readDirty({ root: "/a", paths: ["x.ts"], files: ["/a/x.ts"] }, 1000), 1000);
  rememberDirty(all, readDirty({ root: "/b", paths: ["y.ts"], files: ["/b/y.ts"] }, 2000), 2000);
  assert.deepEqual(freshAllDirty(all, 2500).files, ["/a/x.ts", "/b/y.ts"], "two windows do not overwrite each other");
  rememberDirty(all, readDirty({ root: "/a", paths: [], files: [] }, 3000), 3000);
  assert.deepEqual(freshAllDirty(all, 3000).files, ["/b/y.ts"], "a window that saved everything is forgotten");
  assert.deepEqual(freshAllDirty(all, 2000 + DIRTY_FRESH_MS).files, [], "and one that stops saying is stale");
});

test("file counts hold for a log as a reopened page is sent it, older change sets without their text", () => {
  const log: SessionEvent[] = [
    said(1, "a"), ev(2, { type: "run.started", causedBy: 1, checkpoint: sha("a") }), diff(3, { "A.md": "+a" }), ev(4, { type: "run.ended", outcome: "done", after: sha("b") }),
    said(5, "b"), ev(6, { type: "run.started", causedBy: 5, checkpoint: sha("b") }), diff(7, { "A.md": "+a", "B.md": "+b" }), ev(8, { type: "run.ended", outcome: "done", after: sha("c") }),
    said(9, "c"), ev(10, { type: "run.started", causedBy: 9, checkpoint: sha("c") }), diff(11, { "A.md": "+a", "B.md": "+b", "C.md": "+c", "D.md": "+d" }), ev(12, { type: "run.ended", outcome: "done" }),
  ];
  const live = log;
  const reopened = lightLog(internPatches(structuredClone(log)));
  assert.equal(reopened.filter((e) => e.body.type === "agent.diff" && e.body.files.some((f) => !f.patch)).length, 2, "the older change sets arrive without their text");
  for (const l of [live, reopened]) {
    assert.deepEqual(turnsOf(l).map((t) => t.files), [2, 1, 1], "the files each turn changed");
    assert.deepEqual(filesFrom(l, 9), ["C.md", "D.md"]);
    assert.deepEqual(filesFrom(l, 5), ["B.md", "C.md", "D.md"]);
    assert.deepEqual(filesFrom(l, 1), ["A.md", "B.md", "C.md", "D.md"]);
  }
});

test("a rewind, its redo, and an undo of that redo stands rewound again, with a Redo", () => {
  const base = [...twoTurns(), ev(9, { type: "folder.restored", sha: sha("a"), undo: sha("c"), restored: 2, removed: 1, whole: true }, undefined, "human")];
  const redo = ev(10, { type: "folder.restored", sha: sha("c"), undo: sha("d"), restored: 3, removed: 0 });
  assert.equal(rewoundNow([...base, redo]), null, "redone");
  const again = ev(11, { type: "folder.restored", sha: sha("d"), undo: sha("e"), restored: 3, removed: 0 });
  assert.deepEqual(rewoundNow([...base, redo, again]), { seq: 9, lane: "main", files: 3, undo: sha("e") }, "its Redo goes back to before the undo of the redo");
});

test("a message queued while a run goes is the next run's turn, not the run that was going", () => {
  const log = [
    said(1, "first"), ev(2, { type: "run.started", causedBy: 1, checkpoint: sha("a") }),
    said(3, "queued while it works"),
    diff(4, { "A.md": "+a" }), ev(5, { type: "run.ended", outcome: "done", after: sha("b") }),
    ev(6, { type: "run.started", causedBy: 3, checkpoint: sha("b") }), diff(7, { "A.md": "+a", "B.md": "+b" }), ev(8, { type: "run.ended", outcome: "done" }),
  ];
  assert.deepEqual(turnsOf(log).map((t) => [t.seq, t.files]), [[3, 1], [1, 1]]);
  assert.deepEqual(filesFrom(log, 3), ["B.md"], "A.md was the first run's");
});

test("the extension tells Friday which files are unsaved, when that changes", async () => {
  const dirty = require("../src/vscode-ext/friday/dirty.js");
  const docs: { isDirty: boolean; uri: { scheme: string; fsPath: string } }[] = [
    { isDirty: true, uri: { scheme: "file", fsPath: "/p/README.md" } },
    { isDirty: false, uri: { scheme: "file", fsPath: "/p/clean.md" } },
    { isDirty: true, uri: { scheme: "untitled", fsPath: "Untitled-1" } },
    { isDirty: true, uri: { scheme: "file", fsPath: "/p/src/b.ts" } },
  ];
  const handlers: Record<string, () => void> = {};
  const vscode = { workspace: { textDocuments: docs, onDidChangeTextDocument: (f: () => void) => ((handlers.change = f), { dispose() {} }), onDidSaveTextDocument: (f: () => void) => ((handlers.save = f), { dispose() {} }) } };
  const rel = (root: string, f: string) => f.replace(`${root}/`, "");
  assert.deepEqual(dirty.dirtyPaths(vscode, () => ["/p"], rel), ["README.md", "src/b.ts"]);
  // A folder that only starts the same is not the file's folder; a Windows drive's case does not decide it.
  const sib = { workspace: { textDocuments: [{ isDirty: true, uri: { scheme: "file", fsPath: "/a/foobar/x.ts" } }, { isDirty: true, uri: { scheme: "file", fsPath: "C:\\Work\\p\\y.ts" } }] } };
  assert.deepEqual(dirty.dirtyDocs(sib, () => ["/a/foo", "c:\\work\\p"]).map((d: { root: string }) => d.root), ["", "c:\\work\\p"]);
  const posted: unknown[] = [];
  const subs: { dispose(): void }[] = [];
  const api = dirty.register(vscode, { subscriptions: subs }, { roots: () => ["/p"], relative: rel, post: async (b: unknown) => void posted.push(b) });
  await api.flush();
  assert.deepEqual(posted, [{ root: "/p", paths: ["README.md", "src/b.ts"], files: ["/p/README.md", "/p/src/b.ts"] }]);
  docs.forEach((d) => (d.isDirty = false));
  await api.flush();
  await api.flush();
  assert.deepEqual(posted.at(-1), { root: "/p", paths: [], files: [] });
  assert.equal(posted.length, 2, "an empty list is said once");
  assert.ok(typeof handlers.change === "function" && typeof handlers.save === "function");
  subs.forEach((s) => s.dispose());
  // An IDE without the API: nothing registered, nothing thrown.
  assert.deepEqual(dirty.register({ workspace: {} }, { subscriptions: [] }, { roots: () => [], relative: rel, post: async () => {} }).paths(), []);
});
