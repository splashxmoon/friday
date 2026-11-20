import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// A teammate's pull request checked out on the side (Arun, 2026-11-19, wave 3: "their branch checked out on the side"): a copy of its
// own, the person's checkout untouched, the same copy used again, and what it is of kept in it.
const tmp = mkdtempSync(path.join(os.tmpdir(), "friday-pr-checkout-"));
process.env.FRIDAY_WORKTREES = path.join(tmp, "worktrees");
process.env.GH_TOKEN = "test-token";
const { prCheckout, prDiff, prKeep, prKept, isOwnCheckout } = await import("../src/runner/git.js");

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

test("the head is checked out beside the folder, reused, kept as it is when changed, and its diff reads against the base", async () => {
  const origin = path.join(tmp, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  const seed = path.join(tmp, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(path.join(seed, "a.txt"), "one\ntwo\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "checkout", "-q", "-b", "topic");
  writeFileSync(path.join(seed, "a.txt"), "one\ntwo\nthree\n");
  git(seed, "commit", "-qam", "more");
  const head = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-q", "origin", "topic");
  // GitHub keeps a pull request's head at refs/pull/<n>/head, a fork's too; the branch itself is not needed.
  git(origin, "update-ref", "refs/pull/3/head", head);
  git(origin, "branch", "-D", "topic");
  const mine = path.join(tmp, "mine");
  git(tmp, "clone", "-q", origin, mine);

  const first = await prCheckout(mine, { name: "mine-pr3", number: 3, base: "main" });
  assert.equal(first.sha, head);
  assert.equal(first.reused, false);
  assert.match(path.basename(first.dir), /^mine-pr3-[0-9a-f]{8}$/);
  assert.equal(git(first.dir, "rev-parse", "HEAD"), head);
  assert.equal(git(first.dir, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached: no branch of Friday's left in the person's repository");
  assert.equal(isOwnCheckout(first.dir), true, "the IDE may open it as a repository");
  assert.equal(git(mine, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the person's checkout is where it was");
  assert.equal(git(mine, "status", "--porcelain"), "");
  assert.match(await prDiff(first.dir, "main"), /\+three/);
  await assert.rejects(prDiff(first.dir, "--output=/tmp/x"), /can't compare against/);
  await assert.rejects(prDiff(mine, "main"), /pull request copy/);

  // What it is of is kept in its own git folder, and read back only for a copy of ours.
  await prKeep(first.dir, JSON.stringify({ url: "https://github.com/a/b/pull/3" }));
  assert.deepEqual(JSON.parse((await prKept(first.dir))!), { url: "https://github.com/a/b/pull/3" });
  assert.equal(await prKept(mine), null, "not a folder of Friday's");
  await assert.rejects(prKeep(mine, "{}"), /isn't a copy/);

  // A second look uses the same copy; the head moved on, it follows, unless something was changed in it.
  const again = await prCheckout(mine, { name: "mine-pr3", number: 3, base: "main" });
  assert.deepEqual([again.dir, again.reused], [first.dir, true]);
  writeFileSync(path.join(seed, "a.txt"), "one\ntwo\nthree\nfour\n");
  git(seed, "commit", "-qam", "newer");
  const newer = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-q", "origin", "topic");
  git(origin, "update-ref", "refs/pull/3/head", newer);
  const followed = await prCheckout(mine, { name: "mine-pr3", number: 3, base: "main" });
  assert.deepEqual([followed.dir, followed.sha], [first.dir, newer]);
  assert.equal(git(first.dir, "rev-parse", "HEAD"), newer);
  writeFileSync(path.join(first.dir, "a.txt"), "edited by the reviewer\n");
  git(origin, "update-ref", "refs/pull/3/head", head);
  const kept = await prCheckout(mine, { name: "mine-pr3", number: 3, base: "main" });
  assert.equal(kept.dir, first.dir);
  assert.equal(git(first.dir, "rev-parse", "HEAD"), newer, "a copy with changes in it is left as it is");
  assert.equal(existsSync(path.join(first.dir, "a.txt")), true);
});

/** An origin with a base branch, and a pull request's head (refs/pull/<n>/head) that adds files, one of them in `.vscode`. */
function repoWithPr(name: string, base: string, numbers: number[]) {
  const origin = path.join(tmp, `${name}.git`);
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", base);
  const seed = path.join(tmp, `${name}-seed`);
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", base);
  writeFileSync(path.join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", base);
  const heads: Record<number, string> = {};
  for (const n of numbers) {
    git(seed, "checkout", "-q", "-b", `pr${n}`, base);
    writeFileSync(path.join(seed, "a.txt"), `one\nchange ${n}\n`);
    mkdirSync(path.join(seed, ".vscode"), { recursive: true });
    // What a stranger's pull request can carry: a task that runs when the folder opens, and workspace settings.
    writeFileSync(path.join(seed, ".vscode", "tasks.json"), JSON.stringify({ version: "2.0.0", tasks: [{ label: "x", type: "shell", command: "touch pwned", runOptions: { runOn: "folderOpen" } }] }));
    writeFileSync(path.join(seed, ".vscode", "settings.json"), "{}\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", `change ${n}`);
    heads[n] = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-q", "origin", `pr${n}`);
    git(origin, "update-ref", `refs/pull/${n}/head`, heads[n]!);
  }
  const clone = path.join(tmp, `${name}-clone`);
  git(tmp, "clone", "-q", origin, clone);
  return { origin, seed, clone, heads };
}

test("a fork's #5 and its upstream's #5, or two clones of one repository, are different copies; a reused one is the same pull request of the same repository", async () => {
  const r = repoWithPr("collide", "main", [5]);
  const mine = r.clone;
  const upstream = "https://github.com/splashxmoon/friday/pull/5";
  const fork = "https://github.com/me/friday/pull/5";
  const a = await prCheckout(mine, { name: "splashxmoon-friday-pr5", number: 5, base: "main", url: upstream });
  await prKeep(a.dir, JSON.stringify({ url: upstream }));
  // Same folder-name prefix (the older naming without the owner), other owner: not the first one's.
  const b = await prCheckout(mine, { name: "splashxmoon-friday-pr5", number: 5, base: "main", url: fork });
  assert.notEqual(b.dir, a.dir, "a copy is of one owner's pull request");
  assert.equal(b.reused, false);
  await prKeep(b.dir, JSON.stringify({ url: fork }));
  assert.equal((await prCheckout(mine, { name: "splashxmoon-friday-pr5", number: 5, base: "main", url: fork })).dir, b.dir);
  assert.equal((await prCheckout(mine, { name: "splashxmoon-friday-pr5", number: 5, base: "main", url: "https://github.com/SPLASHXMOON/FRIDAY/pull/5" })).dir, a.dir, "owner and repository compare without case");
  // A second clone of the same repository: the copy belongs to the first clone's repository, so this makes its own.
  const other = path.join(tmp, "collide-clone2");
  git(tmp, "clone", "-q", r.origin, other);
  const c = await prCheckout(other, { name: "splashxmoon-friday-pr5", number: 5, base: "main", url: upstream });
  assert.notEqual(c.dir, a.dir);
  assert.equal(c.reused, false);
  assert.equal(git(c.dir, "rev-parse", "HEAD"), r.heads[5]);
});

test("the pull request's own .vscode is not in its copy (the IDE trusts every folder it opens); it is still in git, not a change, and follows the head", async () => {
  const r = repoWithPr("vsc", "main", [8]);
  const url = "https://github.com/a/vsc/pull/8";
  const first = await prCheckout(r.clone, { name: "a-vsc-pr8", number: 8, base: "main", url });
  await prKeep(first.dir, JSON.stringify({ url }));
  assert.equal(existsSync(path.join(first.dir, ".vscode")), false, "no tasks.json to run when the folder opens");
  assert.equal(existsSync(path.join(first.dir, "pwned")), false);
  assert.equal(git(first.dir, "status", "--porcelain"), "", "its absence is not a change");
  assert.match(git(first.dir, "ls-files", ".vscode"), /tasks\.json/, "still part of the commit");
  assert.match(await prDiff(first.dir, "main"), /\.vscode\/tasks\.json/, "and of the diff the person reviews");
  // The IDE writes its own files there: not a change either. The head moves on and the copy follows, with .vscode out again.
  mkdirSync(path.join(first.dir, ".vscode"), { recursive: true });
  writeFileSync(path.join(first.dir, ".vscode", "ide.json"), "{}");
  git(r.seed, "checkout", "-q", "pr8");
  writeFileSync(path.join(r.seed, ".vscode", "tasks.json"), JSON.stringify({ version: "2.0.0", tasks: [] }));
  git(r.seed, "commit", "-qam", "again");
  const newer = git(r.seed, "rev-parse", "HEAD");
  git(r.seed, "push", "-q", "origin", "pr8");
  git(r.origin, "update-ref", "refs/pull/8/head", newer);
  const second = await prCheckout(r.clone, { name: "a-vsc-pr8", number: 8, base: "main", url });
  assert.deepEqual([second.dir, second.sha, second.reused], [first.dir, newer, true]);
  assert.equal(git(first.dir, "rev-parse", "HEAD"), newer);
  assert.equal(existsSync(path.join(first.dir, ".vscode", "tasks.json")), false);
});

test("a base branch with # + @ in its name is read, and two pull requests opened at once keep their own heads", async () => {
  const r = repoWithPr("odd", "rel#1+x@2", [11, 12]);
  const [a, b] = await Promise.all([
    prCheckout(r.clone, { name: "a-odd-pr11", number: 11, base: "rel#1+x@2", url: "https://github.com/a/odd/pull/11" }),
    prCheckout(r.clone, { name: "a-odd-pr12", number: 12, base: "rel#1+x@2", url: "https://github.com/a/odd/pull/12" }),
  ]);
  assert.equal(a.sha, r.heads[11]);
  assert.equal(b.sha, r.heads[12]);
  assert.match(await prDiff(a.dir, "rel#1+x@2"), /\+change 11/);
  assert.match(await prDiff(b.dir, "rel#1+x@2"), /\+change 12/);
  await assert.rejects(prDiff(a.dir, "-x"), /can't compare against/);
  await assert.rejects(prDiff(a.dir, "a..b"), /can't compare against/);
  await assert.rejects(prDiff(a.dir, "x@{1}"), /can't compare against/);
  await assert.rejects(prDiff(r.clone, "main"), /isn't a pull request copy/);
});
