// What a new copy of a repo is given besides what git has (git.ts copyIncluded): ignored `.env` files, or what
// `.worktreeinclude` names, and nothing else.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { addWorktree, checkpoint, copyIncluded, diffSince, dropWorktree } from "../src/runner/git.js";

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "friday-include-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  g("init", "-q");
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }
  g("add", ".gitignore", "app.js");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start");
  return root;
}

test("by default the ignored .env files come across; untracked work, big files and what the copy has stay put", async (t) => {
  const root = await repo({
    ".gitignore": ".env\n.env.*\nsecrets/\nbig.env\n",
    "app.js": "x",
    ".env": "KEY=1",
    ".env.local": "LOCAL=1",
    "secrets/key.txt": "s",
    "notes.txt": "work in progress, not ignored",
  });
  const dest = await mkdtemp(path.join(tmpdir(), "friday-include-dest-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dest, { recursive: true, force: true })]));
  await writeFile(path.join(dest, ".env.local"), "ALREADY");
  const copied = await copyIncluded(root, dest);
  assert.deepEqual(copied.sort(), [".env"], "the .env, and not the one the copy already has");
  assert.equal(await readFile(path.join(dest, ".env"), "utf8"), "KEY=1");
  assert.equal(await readFile(path.join(dest, ".env.local"), "utf8"), "ALREADY", "never overwritten");
});

test("a copy's .env stays out of what the run changed, its checkpoints and its commits", async (t) => {
  const root = await repo({ ".gitignore": ".env\n", "app.js": "x", ".env": "KEY=secret" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = await addWorktree(root, "agent");
  t.after(() => dropWorktree(copy.path).then(() => {}));
  assert.equal(await readFile(path.join(copy.path, ".env"), "utf8"), "KEY=secret", "the copy got it");
  const base = await checkpoint(copy.path, "before");
  assert.ok(base);
  await writeFile(path.join(copy.path, "app.js"), "y");
  await writeFile(path.join(copy.path, ".env"), "KEY=changed");
  const changed = await diffSince(copy.path, base!);
  assert.deepEqual(changed.map((f) => f.path), ["app.js"], "the run's change, and not the .env");
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: copy.path, encoding: "utf8" });
  assert.doesNotMatch(status, /\.env/, "git sees nothing to commit in it either");
});

test(".worktreeinclude names what comes instead, and only what git ignores", async (t) => {
  const root = await repo({
    ".gitignore": ".env\nsecrets/\n",
    ".worktreeinclude": "secrets/\nnotes.txt\n",
    "app.js": "x",
    ".env": "KEY=1",
    "secrets/key.txt": "s",
    "notes.txt": "named but not ignored",
  });
  const dest = await mkdtemp(path.join(tmpdir(), "friday-include-dest-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dest, { recursive: true, force: true })]));
  assert.deepEqual(await copyIncluded(root, dest), ["secrets/key.txt"]);
});
