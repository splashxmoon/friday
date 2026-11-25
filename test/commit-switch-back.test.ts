// A commit onto a branch that a hook refuses (src/runner/git.ts commitAll; spec 13, "What can break" 12): the folder goes back
// where it was, and when it can't, that is said with the commit's error, naming the branch it is on, never swallowed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll } from "../src/runner/git.js";

async function repo(): Promise<{ dir: string; g: (...a: string[]) => string; done: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-switch-back-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("config", "core.autocrlf", "false");
  await writeFile(path.join(dir, "app.txt"), "a\n");
  await writeFile(path.join(dir, "gen.txt"), "made by the build\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return { dir, g, done: () => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
const hook = async (dir: string, body: string) => {
  const file = path.join(dir, ".git", "hooks", "pre-commit");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
};

test("a refused commit onto a new branch leaves the folder where it was and the branch gone", { skip: process.platform === "win32" }, async (t) => {
  const { dir, g, done } = await repo();
  t.after(done);
  await hook(dir, 'echo "lint failed" >&2; exit 1');
  await writeFile(path.join(dir, "app.txt"), "a\nb\n");
  await assert.rejects(commitAll(dir, "work", "friday/new-work"), /lint failed/);
  assert.equal(g("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(g("branch", "--list", "friday/new-work"), "", "the branch made for it is gone");
});

test("when the folder can't go back, the commit's error says so and names the branch it is on", { skip: process.platform === "win32" }, async (t) => {
  const { dir, g, done } = await repo();
  t.after(done);
  // A branch without gen.txt: switching to it takes the file away. The hook writes it back and refuses, so going back to main
  // would overwrite an untracked file, and git won't.
  g("switch", "-q", "-c", "release");
  g("rm", "-q", "gen.txt");
  g("commit", "-qm", "no generated file here");
  g("switch", "-q", "main");
  await hook(dir, 'echo "made by the build" > gen.txt; echo "tests failed" >&2; exit 1');
  await writeFile(path.join(dir, "app.txt"), "a\nchanged\n");
  const err = await commitAll(dir, "work", "release").then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(err, "the commit was refused");
  assert.match(err.message, /tests failed/, "the hook's own words first");
  assert.match(err.message, /couldn't go back to main and is still on release/);
  assert.match(err.message, /gen\.txt/, "and why it couldn't");
  assert.equal(g("rev-parse", "--abbrev-ref", "HEAD"), "release", "where the message says it is");
  assert.equal(g("branch", "--list", "release"), "* release", "an existing branch is never deleted");
});
