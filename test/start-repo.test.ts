import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { addWorktree, dropWorktree, startRepo } from "../src/runner/git.js";

// Arun, 2026-10-21: "why i cannot run the coding agents in a different work tree on a folder on my desktop, granted it was never
// pushed to github". The folder wasn't in git at all, and a separate copy is a git worktree.
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });

test("a folder never put in git is made a repository on this computer, and an agent gets its own copy of it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-start-repo-"));
  process.env.FRIDAY_WORKTREES = path.join(dir, "..", `${path.basename(dir)}-wt`);
  // Windows keeps a folder busy a moment after git leaves it: tried again rather than failed.
  const gone = (d: string) => rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  t.after(() => Promise.all([gone(dir), gone(process.env.FRIDAY_WORKTREES!)]));
  const project = path.join(dir, "Friday Assistant");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(project, "src", "app.ts"), "export const hi = 1;\n");
  await writeFile(path.join(project, "package.json"), "{}\n");
  await writeFile(path.join(project, ".env"), "SECRET=1\n");
  await writeFile(path.join(project, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");

  await startRepo(project, { name: "Ada" });
  assert.equal(git(project, "rev-list", "--count", "HEAD").trim(), "1", "one first commit");
  assert.equal(git(project, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
  assert.deepEqual(git(project, "ls-files").trim().split("\n").sort(), ["package.json", "src/app.ts"], "dependencies and .env stay out");
  assert.equal(git(project, "remote").trim(), "", "nothing to push to");
  assert.ok(!existsSync(path.join(project, ".gitignore")), "no file added to the folder: the exclusions are git's own");
  assert.equal(git(project, "status", "--porcelain").trim(), "", "and the folder reads as clean");
  // Already a repository: left as it is.
  await startRepo(project, { name: "Ada" });
  assert.equal(git(project, "rev-list", "--count", "HEAD").trim(), "1");

  const copy = await addWorktree(project, "Codex");
  assert.ok(existsSync(path.join(copy.path, "src", "app.ts")));
  assert.match(copy.branch, /^friday\/codex-/);
  await dropWorktree(copy.path).catch(() => {});
});

test("never the home folder or a whole disk", async () => {
  await assert.rejects(startRepo(homedir(), { name: "Ada" }), /not your home folder/);
  await assert.rejects(startRepo(path.parse(process.cwd()).root, { name: "Ada" }), /not your home folder/);
});
