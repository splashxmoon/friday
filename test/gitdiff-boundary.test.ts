import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readRepo } from "../src/runner/repo-read.js";

/**
 * The Git panel's diff of one file shows a file git doesn't track as wholly new, by reading it. That read is a read like any
 * other: inside the folder, and never a key file. A `:/` pathspec gets past git's own "outside repository" check, so
 * `:/../../etc/hosts` (with a folder named `:` in the repository) read any file the server or the host's computer could, a
 * session viewer asking; so did an absolute path, and a link in the folder pointing out of it.
 */

let top = "";
let repo = "";
let secret = "";
const plan = { mode: "plan" as const };

before(async () => {
  top = await mkdtemp(path.join(tmpdir(), "friday-gitdiff-"));
  repo = path.join(top, "repo");
  secret = path.join(top, "secret.txt");
  await mkdir(path.join(repo, ":"), { recursive: true });
  await writeFile(path.join(repo, ":", "k"), "x\n");
  await writeFile(secret, "TOP-SECRET\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await symlink("..", path.join(repo, "up"));
  await writeFile(path.join(repo, "id_rsa"), "PRIVATE-KEY\n");
  await writeFile(path.join(repo, "new.txt"), "hello\n");
});
after(() => rm(top, { recursive: true, force: true }));

const diff = async (p: string) => JSON.stringify(JSON.parse(await readRepo(repo, { op: "gitdiff", path: p, ...plan })));

test("an untracked file's diff never reads outside the folder or a key file", async () => {
  const depth = repo.split(path.sep).length + 2;
  for (const p of [`:/${"../".repeat(depth)}${secret.slice(1)}`, secret, "up/secret.txt", ":(top)up/secret.txt"]) {
    assert.doesNotMatch(await diff(p), /TOP-SECRET/, p);
  }
  assert.doesNotMatch(await diff("id_rsa"), /PRIVATE-KEY/);
  // An ordinary new file still shows whole.
  assert.match(await diff("new.txt"), /\+hello/);
});
