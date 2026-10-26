import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPatch, compareOf, discardFiles, gitDiffOf, logOf, parseStatus, showOf, stageFiles, statusOf, unstageFiles } from "../src/runner/git.js";
import { hunksOf } from "../src/client/git-hunks.js";

/** The Git panel's operations (Arun, 2026-10-25): stage or throw away by file or by hunk, history, how the branch stands. */
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });

async function repo(t: test.TestContext): Promise<string> {
  const r = await mkdtemp(path.join(tmpdir(), "friday-gitpanel-"));
  t.after(() => rm(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await writeFile(path.join(r, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  git(r, "init", "-q", "-b", "main");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "init");
  return r;
}

test("git status --porcelain is read into staged, unstaged, untracked and conflicted, renames with their old path", () => {
  const raw = ["M  staged.ts", " M unstaged.ts", "MM both.ts", "A  new.ts", "D  gone.ts", "R  new-name.ts", "old-name.ts", "?? scratch.txt", "UU clash.ts", ""].join("\0");
  const s = parseStatus(raw);
  assert.deepEqual(s.staged.map((e) => `${e.status}:${e.path}${e.from ? `<${e.from}` : ""}`), ["modified:staged.ts", "modified:both.ts", "added:new.ts", "deleted:gone.ts", "renamed:new-name.ts<old-name.ts"]);
  assert.deepEqual(s.unstaged.map((e) => e.path), ["unstaged.ts", "both.ts"]);
  assert.deepEqual(s.untracked, ["scratch.txt"]);
  assert.deepEqual(s.conflicted, ["clash.ts"]);
});

test("files are staged, unstaged and thrown away; an untracked file goes only when asked", async (t) => {
  const r = await repo(t);
  await writeFile(path.join(r, "a.txt"), "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  await writeFile(path.join(r, "b.txt"), "new\n");
  let s = await statusOf(r);
  assert.equal(s.branch, "main");
  assert.deepEqual([s.staged.length, s.unstaged.map((e) => e.path), s.untracked], [0, ["a.txt"], ["b.txt"]]);
  await stageFiles(r, ["a.txt", "b.txt"]);
  s = await statusOf(r);
  assert.deepEqual(s.staged.map((e) => `${e.status}:${e.path}`), ["modified:a.txt", "added:b.txt"]);
  await unstageFiles(r, ["b.txt"]);
  s = await statusOf(r);
  assert.deepEqual([s.staged.map((e) => e.path), s.untracked], [["a.txt"], ["b.txt"]]);
  await discardFiles(r, ["a.txt", "b.txt"], false);
  s = await statusOf(r);
  assert.deepEqual([s.staged, s.unstaged, s.untracked], [[], [], ["b.txt"]], "the tracked change is gone; the untracked file stays until asked");
  await discardFiles(r, ["b.txt"], true);
  assert.deepEqual((await statusOf(r)).untracked, []);
});

test("one hunk of a file is staged on its own, and another thrown away, from the panel's own split of the diff", async (t) => {
  const r = await repo(t);
  await writeFile(path.join(r, "a.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
  const d = await gitDiffOf(r, false, "a.txt");
  const hunks = hunksOf(d[0]!);
  assert.equal(hunks.length, 2, "two changes far enough apart are two hunks");
  await applyPatch(r, hunks[0]!.patch, { cached: true });
  let s = await statusOf(r);
  assert.deepEqual([s.staged.map((e) => e.path), s.unstaged.map((e) => e.path)], [["a.txt"], ["a.txt"]], "part staged, part not");
  assert.match((await gitDiffOf(r, true))[0]!.patch, /\+ONE/);
  assert.doesNotMatch((await gitDiffOf(r, true))[0]!.patch, /\+TEN/);
  // The other hunk thrown away from the working file.
  const rest = hunksOf((await gitDiffOf(r, false, "a.txt"))[0]!);
  assert.equal(rest.length, 1);
  await applyPatch(r, rest[0]!.patch, { reverse: true });
  s = await statusOf(r);
  assert.deepEqual([s.staged.map((e) => e.path), s.unstaged], [["a.txt"], []]);
  assert.match(await readFile(path.join(r, "a.txt"), "utf8"), /^ONE\n[\s\S]*\nten\n$/);
});

test("history, one commit's changes, and how the branch stands to another", async (t) => {
  const r = await repo(t);
  await writeFile(path.join(r, "a.txt"), "changed\n");
  git(r, "commit", "-qam", "second");
  git(r, "branch", "other", "HEAD~1");
  const log = await logOf(r, 10);
  assert.deepEqual(log.map((c) => c.subject), ["second", "init"]);
  assert.equal(log[0]!.pushed, undefined, "no upstream, so nothing is said about pushing");
  assert.ok(log[0]!.at > 0 && log[0]!.author === "t");
  const shown = await showOf(r, log[0]!.sha);
  assert.deepEqual(shown.map((f) => f.path), ["a.txt"]);
  assert.match(shown[0]!.patch, /-one[\s\S]*\+changed/);
  assert.deepEqual(await compareOf(r, "other"), { base: "other", ahead: 1, behind: 0, files: 1, additions: 1, deletions: 10 });
});

test("Git panel: comparing to main finds it on origin or as master, and a folder with none of those gets a quiet answer, not a failure", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const dir = await mkdtemp(path.join(tmpdir(), "friday-compare-"));
  const g = (...a: string[]) => run("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  await g("init", "-q", "-b", "trunk");
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await g("add", "a.txt");
  await g("commit", "-qm", "first");
  const { compareOf } = await import("../src/runner/git.js");
  const none = await compareOf(dir, "main");
  assert.equal(none.missing, true);
  assert.equal(none.base, "main");
  // master stands in for main; a branch on origin counts too.
  await g("branch", "master");
  await g("checkout", "-qb", "work");
  await writeFile(path.join(dir, "b.txt"), "two\n");
  await g("add", "b.txt");
  await g("commit", "-qm", "second");
  const m = await compareOf(dir, "master");
  assert.equal(m.ahead, 1);
  assert.equal(m.files, 1);
  const viaMain = await compareOf(dir, "main");
  assert.equal(viaMain.missing, undefined);
  assert.equal(viaMain.base, "master");
  assert.equal(viaMain.ahead, 1);
});
