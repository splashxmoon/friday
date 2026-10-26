import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { branchesOf, remoteBranchesOf, switchBranch } from "../src/runner/git.js";
import { callHost } from "../src/runner/local-api.js";
import { branchRef } from "../src/client/Branches.js";

/**
 * The new-session page's branch pick (Arun, 2026-10-25: "make sure they can change the branch they want to work on"): the
 * folder lists its branches and origin's, and a new branch starts from the one picked rather than whatever is checked out.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function repos() {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-branch-pick-"));
  const origin = path.join(dir, "origin");
  const work = path.join(dir, "work");
  git(dir, "init", "-q", "-b", "main", origin);
  writeFileSync(path.join(origin, "a.txt"), "a\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "first");
  git(origin, "switch", "-q", "-c", "feature");
  writeFileSync(path.join(origin, "f.txt"), "f\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "feature work");
  git(origin, "switch", "-q", "main");
  git(dir, "clone", "-q", origin, work);
  git(work, "switch", "-q", "-c", "local-only");
  git(work, "switch", "-q", "main");
  return { dir, work };
}

test("a folder lists its own branches, then origin's that aren't here, without fetching", async (t) => {
  const { dir, work } = repos();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual((await branchesOf(work)).branches.map((b) => b.name).sort(), ["local-only", "main"]);
  assert.deepEqual(await remoteBranchesOf(work), ["feature"], "main is here already, and origin's HEAD isn't a branch");
  const r = (await callHost("describe", { path: work, branches: true }, { serverUrl: "", user: { id: "u", name: "U" }, runners: new Map() })) as { folder: { branch?: string; branches?: { name: string; remote?: true }[] } };
  assert.equal(r.folder.branch, "main");
  assert.deepEqual(r.folder.branches?.map((b) => `${b.name}${b.remote ? " (origin)" : ""}`).sort(), ["feature (origin)", "local-only", "main"]);
  const plain = (await callHost("describe", { path: work }, { serverUrl: "", user: { id: "u", name: "U" }, runners: new Map() })) as { folder: { branches?: unknown } };
  assert.equal(plain.folder.branches, undefined, "only when asked: every other look at a folder stays as quick as it was");
});

test("a new branch starts from the branch picked, origin's included; an existing one is switched to", async (t) => {
  const { dir, work } = repos();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // From a branch only origin has: named as origin's.
  await switchBranch(work, "fix-1", branchRef({ name: "feature", remote: true }, "feature"));
  assert.equal(git(work, "branch", "--show-current"), "fix-1");
  assert.equal(git(work, "log", "-1", "--format=%s"), "feature work", "it starts where the picked branch is, not where the folder was");
  // From a branch of this checkout.
  await switchBranch(work, "fix-2", "local-only");
  assert.equal(git(work, "rev-parse", "HEAD"), git(work, "rev-parse", "local-only"));
  // Without a pick, as before: from what is checked out.
  await switchBranch(work, "fix-3");
  assert.equal(git(work, "rev-parse", "HEAD"), git(work, "rev-parse", "local-only"));
  // An origin-only branch picked to work on is had with its commits, not made up from the checkout.
  await switchBranch(work, "feature");
  assert.equal(git(work, "log", "-1", "--format=%s"), "feature work");
});
