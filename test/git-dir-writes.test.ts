import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { checkpoint } from "../src/runner/git.js";
import { readRepo } from "../src/runner/repo-read.js";

/**
 * A file write is an Edits-mode thing; running a command is not. Git runs what its config says (core.fsmonitor, core.pager,
 * hooks), so a write into `.git` turned "may change files" into "may run anything" the next time Friday ran git there.
 */

let repo = "";
const edits = { mode: "edits" as const };
const config = "[core]\n\tfsmonitor = touch pwned\n";

before(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "friday-gitdir-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await symlink(".git", path.join(repo, "g"));
});
after(() => rm(repo, { recursive: true, force: true }));

test("nothing inside .git can be written or edited, however it is spelled or reached", async () => {
  const before = await readFile(path.join(repo, ".git", "config"), "utf8");
  for (const p of [".git/config", ".GIT/config", "./.git/hooks/pre-commit", "src/../.git/config", "g/config", ".git"]) {
    const w = await readRepo(repo, { op: "write", path: p, content: config, ...edits });
    assert.match(w, /git's own folder/, `write ${p}: ${w}`);
  }
  const e = await readRepo(repo, { op: "edit", path: ".git/config", find: "[core]", content: config, ...edits });
  assert.match(e, /git's own folder/);
  assert.equal(await readFile(path.join(repo, ".git", "config"), "utf8"), before);
  assert.equal(existsSync(path.join(repo, ".git", "hooks", "pre-commit")), false);
  // Ordinary files, and one merely named like it, still are.
  assert.match(await readRepo(repo, { op: "write", path: "src/.gitignore", content: "x\n", ...edits }), /Created/);
  assert.match(await readRepo(repo, { op: "write", path: "docs/.github/x.md", content: "x\n", ...edits }), /Created/);
});

test("Friday's own git never runs a core.fsmonitor that is already in a repository's config", async () => {
  execFileSync("git", ["config", "core.fsmonitor", "touch pwned"], { cwd: repo });
  await checkpoint(repo, "test").catch(() => null);
  assert.equal(existsSync(path.join(repo, "pwned")), false);
});
