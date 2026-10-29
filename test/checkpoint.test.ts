import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { addWorktree, checkpoint, commitAll, diffSince, diffTrees, dropWorktree, publish, remoteOf, restore } from "../src/runner/git.js";
import { commitPaths } from "../src/shepherd.js";

/**
 * Undo is only worth a button if it puts back exactly what the run touched,
 * and nothing the person was doing: not their staged work, not their branch,
 * not the files git ignores.
 */

let repo = "";
const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const exists = (f: string) => stat(path.join(repo, f)).then(() => true, () => false);

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "friday-ckpt-"));
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await writeFile(path.join(repo, "gone.txt"), "keep me\n");
  g("add", "-A");
  g("commit", "-qm", "init");
});
after(() => rm(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("undo puts back edits, removes new files and restores deleted ones", async () => {
  // Work the person had going before the run, some of it staged.
  await writeFile(path.join(repo, "a.txt"), "one, edited by a human\n");
  await writeFile(path.join(repo, "draft.txt"), "untracked human draft\n");
  g("add", "a.txt");
  const stagedBefore = g("diff", "--cached", "--name-only");
  const headBefore = g("rev-parse", "HEAD");

  const sha = await checkpoint(repo, "run 1");
  assert.match(sha ?? "", /^[0-9a-f]{40}$/);
  assert.equal(g("diff", "--cached", "--name-only"), stagedBefore, "taking a checkpoint doesn't touch the index");

  // The run.
  await writeFile(path.join(repo, "a.txt"), "rewritten by the agent\n");
  await writeFile(path.join(repo, "new.ts"), "export {}\n");
  await rm(path.join(repo, "gone.txt"));

  const r = await restore(repo, sha!);
  assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "one, edited by a human\n", "the human's edit survives, the agent's doesn't");
  assert.equal(await exists("new.ts"), false, "a file the run created is removed");
  assert.equal(await readFile(path.join(repo, "gone.txt"), "utf8"), "keep me\n", "a file the run deleted is back");
  assert.equal(await readFile(path.join(repo, "draft.txt"), "utf8"), "untracked human draft\n", "untracked work from before the run stays");
  assert.equal(g("rev-parse", "HEAD"), headBefore, "HEAD never moves");
  assert.equal(g("diff", "--cached", "--name-only"), stagedBefore, "staged changes are still staged");

  // Undoing the undo is the same operation.
  await restore(repo, r.undo);
  assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "rewritten by the agent\n");
  assert.equal(await exists("new.ts"), true);
  assert.equal(await exists("gone.txt"), false);
});

test("ignored files are never saved or touched", async () => {
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  const sha = await checkpoint(repo, "run 2");
  execFileSync(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", "mkdir node_modules"] : ["-c", "mkdir -p node_modules"], { cwd: repo });
  await writeFile(path.join(repo, "node_modules", "dep.js"), "installed during the run\n");
  await restore(repo, sha!);
  assert.equal(await exists("node_modules/dep.js"), true, "an install isn't undone by deleting node_modules");
});

test("outside a git repository there is no checkpoint, rather than a failure", async () => {
  const plain = await mkdtemp(path.join(tmpdir(), "friday-plain-"));
  assert.equal(await checkpoint(plain, "x"), null);
  await rm(plain, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("a made-up id is refused", async () => {
  await assert.rejects(restore(repo, "not-a-sha"), /isn't a checkpoint/);
  await assert.rejects(restore(repo, "0".repeat(40)), /isn't in this repository/);
});

test("commit stages what the Files tab shows, minus Friday's own files, on a new branch if asked", async () => {
  const { commitAll, githubSlug } = await import("../src/runner/git.js");
  await writeFile(path.join(repo, "feature.ts"), "export const f = 1;\n");
  await writeFile(path.join(repo, "friday-runner.mjs"), "// ours\n");
  const c = await commitAll(repo, "Add feature", "feat/thing");
  assert.equal(c.branch, "feat/thing");
  assert.match(c.sha, /^[0-9a-f]{40}$/);
  assert.ok(g("show", "--name-only", "--format=", "HEAD").includes("feature.ts"));
  assert.ok(!g("show", "--name-only", "--format=", "HEAD").includes("friday-runner.mjs"), "our runner never lands in their history");
  await assert.rejects(commitAll(repo, "again"), /nothing to commit/);
  await assert.rejects(commitAll(repo, "   "), /commit message/);
  await assert.rejects(commitAll(repo, "x", "bad..name"), /isn't a branch name/);

  assert.equal(githubSlug("git@github.com:splashxmoon/Multiplayer-AI.git"), "splashxmoon/Multiplayer-AI");
  assert.equal(githubSlug("https://github.com/splashxmoon/Multiplayer-AI"), "splashxmoon/Multiplayer-AI");
  assert.equal(githubSlug("https://gitlab.com/a/b.git"), null);
});

test("publishing without a remote says so instead of hanging on a prompt", async () => {
  const { publish } = await import("../src/runner/git.js");
  await assert.rejects(publish(repo, { pr: false, title: "x" }), /no remote called origin/);
});

test("push goes to origin, and a pull request from the default branch is refused", async () => {
  const { publish } = await import("../src/runner/git.js");
  const bare = await mkdtemp(path.join(tmpdir(), "friday-bare-"));
  execFileSync("git", ["init", "-q", "--bare"], { cwd: bare });
  g("remote", "add", "origin", bare);
  const p = await publish(repo, { pr: false, title: "x" });
  assert.equal(p.pushed, true);
  assert.equal(execFileSync("git", ["rev-parse", "feat/thing"], { cwd: bare, encoding: "utf8" }).trim(), g("rev-parse", "HEAD"), "the branch is on the remote");
  // -C, not -c: on a machine whose init.defaultBranch is already "main" the
  // branch exists from `git init`, and creating it again fails the fixture
  // rather than the thing under test.
  g("switch", "-q", "-C", "main");
  g("push", "-q", "origin", "main");
  await assert.rejects(publish(repo, { pr: true, title: "x" }), /what a pull request would merge into/);
  await rm(bare, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/**
 * Committing part of a folder, and moving between branches.
 *
 * "Commit everything" is a snapshot, not a commit: a run touches more than the
 * one thing worth recording, and the rest has to survive being left out.
 */
test("a commit can take some of the folder and leave the rest alone", async () => {
  const { commitAll } = await import("../src/runner/git.js");
  g("switch", "-q", "-C", "main");
  await writeFile(path.join(repo, "wanted.txt"), "the change being recorded\n");
  await writeFile(path.join(repo, "unwanted.txt"), "work in progress\n");

  const c = await commitAll(repo, "record only the one file", undefined, ["wanted.txt"]);
  assert.equal(c.files, 1);
  assert.equal(g("show", "--name-only", "--format=", "HEAD"), "wanted.txt");
  assert.match(g("status", "--porcelain"), /unwanted\.txt/, "the file left out is still sitting in the folder");

  // And nothing is left staged behind the person's back.
  assert.equal(g("diff", "--cached", "--name-only"), "");

  const all = await commitAll(repo, "and now the rest");
  assert.equal(all.files, 1);
  // The runner's own file is never one of them, whichever way the commit was asked for.
  assert.doesNotMatch(g("status", "--porcelain"), /unwanted\.txt/);
  assert.equal(g("show", "--name-only", "--format=", "HEAD"), "unwanted.txt");
});

test("branches can be listed, made and moved between", async () => {
  const { branchesOf, switchTo } = await import("../src/runner/git.js");
  g("switch", "-q", "-C", "main");

  const made = await switchTo(repo, "feat/switcher", true);
  assert.equal(made.branch, "feat/switcher");

  const { current, branches } = await branchesOf(repo);
  assert.equal(current, "feat/switcher");
  assert.ok(
    branches.some((b) => b.name === "main"),
    `main is in the list: ${branches.map((b) => b.name).join(", ")}`,
  );

  // A branch that is already there is not something to create.
  await assert.rejects(switchTo(repo, "main", true), /already a branch/);
  assert.equal((await switchTo(repo, "main")).branch, "main", "but it can be switched to");

  // A name git would refuse is refused here, before git is asked.
  await assert.rejects(switchTo(repo, "not a branch name"), /isn't a branch name/);
});

test("a branch checked out in another worktree is listed with where it is, and not as this folder's", async () => {
  const { branchesOf } = await import("../src/runner/git.js");
  g("switch", "-q", "-C", "main");
  const other = await mkdtemp(path.join(tmpdir(), "friday-wt-other-"));
  await rm(other, { recursive: true, force: true });
  g("worktree", "add", "-q", "-b", "friday/claude-b37001cc", other);
  try {
    const { current, branches } = await branchesOf(repo);
    assert.equal(current, "main");
    const there = branches.find((b) => b.name === "friday/claude-b37001cc");
    assert.ok(there?.elsewhere, "the worktree's branch says which folder has it");
    assert.equal(await realpath(there!.elsewhere!), await realpath(other));
    assert.equal(branches.find((b) => b.name === "main")?.elsewhere, undefined, "this folder's own branch is not elsewhere");
    // From inside the worktree it is the other way round.
    const inside = await branchesOf(other);
    assert.equal(inside.current, "friday/claude-b37001cc");
    assert.ok(inside.branches.find((b) => b.name === "main")?.elsewhere, "main is in the first folder");
  } finally {
    g("worktree", "remove", "--force", other);
    g("branch", "-q", "-D", "friday/claude-b37001cc");
  }
});

test("a folder that is not a repository says so rather than failing obscurely", async () => {
  const { branchesOf, switchTo } = await import("../src/runner/git.js");
  const plain = await mkdtemp(path.join(tmpdir(), "friday-plain-"));
  await assert.rejects(branchesOf(plain), /isn't a git repository/);
  await assert.rejects(switchTo(plain, "main"), /isn't a git repository/);
  await rm(plain, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("a snapshot after the first only re-reads what changed, and comes out the same as one read from scratch", async () => {
  const r = await mkdtemp(path.join(tmpdir(), "friday-ckpt-kept-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: r, encoding: "utf8" }).trim();
  // What a snapshot built from nothing would be: HEAD, then the folder on top, bytes as they are on disk.
  const fresh = async () => {
    const index = `${r}-fresh-index`;
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const raw = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
    execFileSync("git", [...raw, "read-tree", "HEAD"], { cwd: r, env });
    execFileSync("git", [...raw, "add", "-A", "--", "."], { cwd: r, env });
    const tree = execFileSync("git", [...raw, "write-tree"], { cwd: r, env, encoding: "utf8" }).trim();
    await rm(index, { force: true });
    return tree;
  };
  const snap = async () => run("rev-parse", `${(await checkpoint(r, "x"))!}^{tree}`);
  try {
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "T");
    // The Windows default, which the person's own index is written with and a snapshot must not be.
    run("config", "core.autocrlf", "true");
    await writeFile(path.join(r, ".gitignore"), "*.env\n");
    await writeFile(path.join(r, "a.txt"), "one\r\ntwo\r\n");
    await writeFile(path.join(r, "b.txt"), "bee\n");
    run("add", "-A");
    run("commit", "-qm", "init");

    assert.equal(await snap(), await fresh(), "the first snapshot");

    // Same size, written straight after the last snapshot: the case a stat cache could miss.
    await writeFile(path.join(r, "a.txt"), "ONE\r\ntwo\r\n");
    await writeFile(path.join(r, "new.txt"), "untracked\n");
    await rm(path.join(r, "b.txt"));
    const t = await snap();
    assert.equal(t, await fresh(), "edits, a new file and a deletion");
    assert.equal(run("cat-file", "-p", `${t}:a.txt`), "ONE\r\ntwo", "the bytes on disk, CRs and all");

    // A file that was snapshotted and is ignored now drops out, as it would from scratch.
    await writeFile(path.join(r, ".gitignore"), "*.env\nnew.txt\n");
    assert.equal(await snap(), await fresh(), "newly ignored");

    // Another branch that tracks a file its ignore rules match: a fresh index has it from HEAD, so the kept one must too.
    run("checkout", "-q", "-b", "other");
    await writeFile(path.join(r, "x.env"), "SECRET=1\n");
    run("add", "-f", "x.env");
    run("commit", "-qm", "tracked env");
    await writeFile(path.join(r, "x.env"), "SECRET=2\n");
    const onOther = await snap();
    assert.equal(onOther, await fresh(), "a tracked file that matches an ignore rule");
    assert.equal(run("cat-file", "-p", `${onOther}:x.env`), "SECRET=2");

    // And back: the kept index has x.env, HEAD doesn't, and neither does the folder.
    run("checkout", "-q", "--", "x.env");
    run("checkout", "-q", "-");
    assert.equal(await snap(), await fresh(), "back on the first branch");
  } finally {
    await rm(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("the kept snapshot index is in the person's own home, not the shared temp folder, and a worktree's goes with it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-ckpt-home-"));
  const r = await mkdtemp(path.join(tmpdir(), "friday-ckpt-wt-"));
  // os.homedir() reads USERPROFILE on Windows, HOME everywhere else.
  const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const saved = { home: process.env[homeVar], worktrees: process.env.FRIDAY_WORKTREES };
  process.env[homeVar] = home;
  process.env.FRIDAY_WORKTREES = path.join(home, "worktrees");
  const kept = () => readdir(path.join(home, ".friday", "snapshot-index")).catch(() => [] as string[]);
  try {
    const run = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: r, stdio: "ignore" });
    await writeFile(path.join(r, "a.txt"), "one\n");
    run("init", "-q");
    run("add", "-A");
    run("commit", "-qm", "init");
    const w = await addWorktree(r, "lane");
    assert.ok(await checkpoint(w.path, "x"));
    // The index, and the list of what it left out beside it (CHECKPOINT_LIMITS).
    assert.deepEqual((await kept()).map((f) => f.replace(/^[0-9a-f]+/, "")).sort(), ["", ".exclude"], "kept under the home folder");
    assert.ok(await dropWorktree(w.path));
    assert.deepEqual(await kept(), [], "and gone with the worktree");
  } finally {
    if (saved.home === undefined) delete process.env[homeVar];
    else process.env[homeVar] = saved.home;
    if (saved.worktrees === undefined) delete process.env.FRIDAY_WORKTREES;
    else process.env.FRIDAY_WORKTREES = saved.worktrees;
    await rm(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a commit takes the file named, not every file its name would match as a pattern, and a name past ASCII as it is", async () => {
  const { commitAll, diffSince } = await import("../src/runner/git.js");
  g("switch", "-q", "-C", "main");
  await mkdir(path.join(repo, "app"), { recursive: true });
  await writeFile(path.join(repo, "app", "[id].tsx"), "page\n");
  await writeFile(path.join(repo, "app", "i.tsx"), "index\n");
  await writeFile(path.join(repo, "café.md"), "un café\n");
  g("add", "-A");
  g("commit", "-qm", "pages");
  await writeFile(path.join(repo, "app", "[id].tsx"), "page, edited\n");
  await writeFile(path.join(repo, "app", "i.tsx"), "index, edited\n");
  await writeFile(path.join(repo, "café.md"), "deux cafés\n");
  assert.deepEqual((await diffSince(repo, "HEAD")).map((f) => f.path).sort(), ["app/[id].tsx", "app/i.tsx", "café.md"], "names as they are, not quoted and escaped");

  // `app/[id].tsx` is one file; as a pattern it also matched `app/i.tsx`, which then went into a commit it was left out of.
  const c = await commitAll(repo, "one page", undefined, ["app/[id].tsx", "café.md"]);
  assert.equal(c.files, 2);
  assert.deepEqual(g("-c", "core.quotePath=false", "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["app/[id].tsx", "café.md"]);
  assert.match(g("status", "--porcelain"), /app\/i\.tsx/, "the file left out is still in the folder");
  await commitAll(repo, "the rest");
});

test("a commit to a new branch with nothing to commit leaves the folder where it was", async () => {
  const { commitAll } = await import("../src/runner/git.js");
  g("switch", "-q", "-C", "main");
  await assert.rejects(commitAll(repo, "nothing", "friday/empty"), /nothing to commit/);
  assert.equal(g("rev-parse", "--abbrev-ref", "HEAD"), "main", "not moved to a branch the session doesn't know about");
  assert.doesNotMatch(g("branch", "--list", "friday/empty"), /friday\/empty/);
});

/** A repository of its own for each test below, with a.txt and b.txt committed on main. */
async function own(t: TestContext): Promise<{ dir: string; run: (...a: string[]) => string; has: (f: string) => Promise<boolean> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-ship-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  run("config", "core.autocrlf", "false");
  await writeFile(path.join(dir, "a.txt"), "a\n");
  await writeFile(path.join(dir, "b.txt"), "b\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  run("branch", "-M", "main");
  return { dir, run, has: (f) => stat(path.join(dir, f)).then(() => true, () => false) };
}
const hook = (file: string, body: string) => writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

test("a redo puts back only what the undo changed: files edited or made since stay as they are", async (t) => {
  const { dir, has } = await own(t);
  const start = (await checkpoint(dir, "run"))!;
  await writeFile(path.join(dir, "a.txt"), "a, by the agent\n");
  await writeFile(path.join(dir, "made.ts"), "export {}\n");
  const end = (await checkpoint(dir, "run end"))!;

  const undone = await restore(dir, start, end);
  assert.match(undone.after ?? "", /^[0-9a-f]{40}$/, "the undo saves where it left the folder");
  assert.equal(await has("made.ts"), false);

  // The person carries on after the undo.
  await writeFile(path.join(dir, "b.txt"), "b, edited after the undo\n");
  await writeFile(path.join(dir, "later.txt"), "made after the undo\n");

  await restore(dir, undone.undo, undone.after!);
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "a, by the agent\n", "the run's edit is back");
  assert.equal(await has("made.ts"), true, "and its file");
  assert.equal(await readFile(path.join(dir, "b.txt"), "utf8"), "b, edited after the undo\n", "an edit made since is kept");
  assert.equal(await has("later.txt"), true, "a file made since is kept");
});

test("a file ignored before the run un-ignored it is never removed by an undo, nor listed as the run's", async (t) => {
  const { dir, run, has } = await own(t);
  await writeFile(path.join(dir, ".gitignore"), ".env\nsecrets/\n");
  run("add", ".gitignore");
  run("commit", "-qm", "ignore");
  await writeFile(path.join(dir, ".env"), "TOKEN=hunter2\n");
  await mkdir(path.join(dir, "secrets"));
  await writeFile(path.join(dir, "secrets", "key.pem"), "private\n");
  const start = (await checkpoint(dir, "run"))!;

  // The run rewrites .gitignore and makes a file of its own.
  await writeFile(path.join(dir, ".gitignore"), "# nothing\n");
  await writeFile(path.join(dir, "made.txt"), "the agent's\n");

  assert.deepEqual((await diffTrees(dir, start)).map((f) => f.path).sort(), [".gitignore", "made.txt"], "not offered for a commit");
  assert.deepEqual((await diffSince(dir, "HEAD")).map((f) => f.path).sort(), [".gitignore", "made.txt"]);

  const r = await restore(dir, start);
  assert.equal(r.removed, 1, "only the run's own file");
  assert.equal(await has("made.txt"), false);
  assert.equal(await readFile(path.join(dir, ".env"), "utf8"), "TOKEN=hunter2\n", "the .env that was there all along stays");
  assert.equal(await has("secrets/key.pem"), true, "and the ignored folder's files");
  assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), ".env\nsecrets/\n");
});

test("past 80 files the change set still names every one, so the commit takes the run's files and nothing of the person's", async (t) => {
  const { dir, run } = await own(t);
  await writeFile(path.join(dir, "b.txt"), "b, the person's unfinished work\n");
  const start = (await checkpoint(dir, "run"))!;
  await mkdir(path.join(dir, "gen"));
  for (let i = 0; i < 85; i++) await writeFile(path.join(dir, "gen", `f${String(i).padStart(2, "0")}.txt`), `${i}\n`);

  // From the last commit the person's b.txt counts too; from where the run started it doesn't.
  for (const [changes, all] of [[await diffSince(dir, "HEAD"), 86], [await diffTrees(dir, start), 85]] as const) {
    assert.equal(changes.length, 80);
    assert.equal(new Set([...changes.map((f) => f.path), ...(changes.more ?? [])]).size, all, "the rest by name");
  }
  const files = await diffTrees(dir, start);
  assert.equal(files.more?.length, 5);
  const c = await commitAll(dir, "generated", undefined, commitPaths(files, files.more));
  assert.equal(c.files, 85);
  assert.match(run("status", "--porcelain"), /^ ?M b\.txt$/, "the person's edit is still theirs, uncommitted");
});

test("a renamed file is committed as a rename, old path and all", async (t) => {
  const { dir, run } = await own(t);
  const start = (await checkpoint(dir, "run"))!;
  await rename(path.join(dir, "a.txt"), path.join(dir, "renamed.txt"));
  const files = await diffTrees(dir, start);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.from]), [["renamed.txt", "renamed", "a.txt"]]);
  await commitAll(dir, "rename", undefined, commitPaths(files));
  assert.equal(run("status", "--porcelain"), "", "nothing left behind: the old path's deletion went in too");
  assert.match(run("show", "--name-status", "--format=", "HEAD"), /^R\d*\s+a\.txt\s+renamed\.txt$/);
});

test("started in a subfolder, new files are named from the top of the repository", async (t) => {
  const { dir } = await own(t);
  await mkdir(path.join(dir, "pkg"));
  await writeFile(path.join(dir, "pkg", "new.ts"), "export const x = 1;\n");
  const files = await diffSince(path.join(dir, "pkg"), "HEAD");
  assert.deepEqual(files.map((f) => [f.path, f.additions]), [["pkg/new.ts", 1]]);
});

test("a commit a hook refuses leaves the folder on its branch, without the branch it was about to make", async (t) => {
  const { dir, run } = await own(t);
  await hook(path.join(dir, ".git", "hooks", "pre-commit"), "echo 'lint failed' >&2\nexit 1");
  await writeFile(path.join(dir, "a.txt"), "a, edited\n");
  await assert.rejects(commitAll(dir, "x", "friday/new", ["a.txt"]), /lint failed/);
  assert.equal(run("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(run("branch", "--list", "friday/new"), "");
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "a, edited\n");
});

test("a commit gives back what the person had staged themselves, and skips a listed file that has gone since", async (t) => {
  const { dir, run } = await own(t);
  await writeFile(path.join(dir, "b.txt"), "b, staged by the person\n");
  run("add", "b.txt");
  await writeFile(path.join(dir, "a.txt"), "a, by the agent\n");
  await writeFile(path.join(dir, "c.txt"), "c, by the agent\n");

  const c = await commitAll(dir, "agent work", undefined, ["a.txt", "c.txt", "vanished.txt"]);
  assert.equal(c.files, 2, "the file that is gone from the folder and from the last commit is left out");
  assert.deepEqual(run("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["a.txt", "c.txt"]);
  assert.equal(run("diff", "--cached", "--name-only"), "b.txt", "still staged");
  assert.equal(run("status", "--porcelain"), "M  b.txt");

  // A commit that fails gives it back as well.
  await assert.rejects(commitAll(dir, "nothing", undefined, ["vanished.txt"]), /nothing to commit/);
  assert.equal(run("diff", "--cached", "--name-only"), "b.txt");
});

test("a remote that refuses a push says why, and only a remote that is ahead says pull first", async (t) => {
  const { dir, run } = await own(t);
  const bare = await mkdtemp(path.join(tmpdir(), "friday-bare-"));
  t.after(() => rm(bare, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  execFileSync("git", ["init", "-q", "--bare"], { cwd: bare });
  run("remote", "add", "origin", bare);
  await hook(path.join(bare, "hooks", "pre-receive"), "echo 'pushes are frozen today' >&2\nexit 1");
  const refused = await publish(dir, { pr: false, title: "x" }).then(() => null, (e: Error) => e.message);
  assert.match(refused ?? "", /pushes are frozen today|declined/);
  assert.doesNotMatch(refused ?? "", /Pull first/);

  await rm(path.join(bare, "hooks", "pre-receive"));
  run("push", "-q", "origin", "main");
  run("commit", "-q", "--amend", "-m", "rewritten");
  await assert.rejects(publish(dir, { pr: false, title: "x" }), /Pull first/);
});

test("a remote's password never reaches the browser, even one with an @ in it", async (t) => {
  const { dir, run } = await own(t);
  run("remote", "add", "origin", "https://ada:p@ss@word@github.com/acme/app.git");
  const r = await remoteOf(dir);
  assert.equal(r.url, "https://github.com/acme/app.git");
  assert.equal(r.github, "acme/app");
});
