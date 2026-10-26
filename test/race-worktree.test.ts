import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { addWorktree, dropWorktree } from "../src/runner/git.js";

// Copies made here go in the temp folder, not the person's own ~/.friday/worktrees.
process.env.FRIDAY_WORKTREES ??= path.join(tmpdir(), "friday-test-worktrees");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "race-src-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  mkdirSync(path.join(dir, "pkg"));
  writeFileSync(path.join(dir, "pkg", "b.txt"), "two\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  mkdirSync(path.join(dir, "node_modules"));
  writeFileSync(path.join(dir, "node_modules", "dep.js"), "module.exports = 1;\n");
  return dir;
}

test("a racer gets its own checkout and branch, and dropping it leaves the real folder and dependencies alone", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  const w = await addWorktree(dir);
  assert.match(w.branch, /^friday\/race-[0-9a-f]{8}$/);
  assert.ok(existsSync(path.join(w.path, "a.txt")), "the files are there");
  assert.equal(readFileSync(path.join(w.path, "node_modules", "dep.js"), "utf8"), "module.exports = 1;\n", "dependencies are reachable");

  // Editing the racer's copy does not touch the original.
  writeFileSync(path.join(w.path, "a.txt"), "changed\n");
  assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "one\n");
  assert.equal(git(w.path, "rev-parse", "--abbrev-ref", "HEAD"), w.branch);

  assert.equal(await dropWorktree(w.path), true);
  assert.ok(!existsSync(w.path), "the checkout is gone");
  assert.equal(readFileSync(path.join(dir, "node_modules", "dep.js"), "utf8"), "module.exports = 1;\n", "the real dependencies survived");
  assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "one\n");
});

test("started from a subfolder, the racer starts in the same subfolder of its copy", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const w = await addWorktree(path.join(dir, "pkg"));
  t.after(() => void dropWorktree(w.path));
  assert.ok(existsSync(path.join(w.path, "b.txt")));
  assert.equal(path.basename(w.path), "pkg");
});

test("a copy that carries the work brings the uncommitted changes along, still uncommitted, and leaves the original as it was", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  writeFileSync(path.join(dir, "a.txt"), "edited\n");
  writeFileSync(path.join(dir, "new.txt"), "fresh\n");
  rmSync(path.join(dir, "pkg", "b.txt"));

  const w = await addWorktree(dir, "Claude Code", true);
  t.after(() => void dropWorktree(w.path));
  // Read without line endings: git on Windows may write the copy with CRLF.
  const text = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  assert.equal(text(path.join(w.path, "a.txt")), "edited\n");
  assert.equal(text(path.join(w.path, "new.txt")), "fresh\n");
  assert.ok(!existsSync(path.join(w.path, "pkg", "b.txt")), "a deletion comes along too");
  const status = git(w.path, "status", "--porcelain", "--", "a.txt", "new.txt", "pkg");
  assert.match(status, /^ ?M a\.txt$/m); // the helper trims the first line's leading space
  assert.match(status, /^\?\? new\.txt$/m);
  assert.match(status, /^ D pkg\/b\.txt$/m);
  assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "edited\n", "the original keeps its changes");
  assert.equal(git(dir, "status", "--porcelain", "--", "a.txt"), "M a.txt");
});

test("carried on from a lane's own copy, the next copy gets the real dependencies, not the link to them as a file", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  // The usual rule, which matches a folder and so not the link a lane's copy has in its place.
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-q", "-m", "ignore");
  const first = await addWorktree(dir, "Claude Code");
  t.after(() => void dropWorktree(first.path));
  writeFileSync(path.join(first.path, "a.txt"), "edited in the lane\n");

  const next = await addWorktree(first.path, "Codex", true);
  t.after(() => void dropWorktree(next.path));
  assert.equal(readFileSync(path.join(next.path, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "edited in the lane\n");
  assert.equal(readFileSync(path.join(next.path, "node_modules", "dep.js"), "utf8"), "module.exports = 1;\n", "dependencies are reachable");
  assert.equal(git(next.path, "status", "--porcelain", "--", "node_modules"), "", "and aren't a change of the agent's");
  // Linked to the real ones, so the copy it came from can go.
  assert.equal(await dropWorktree(first.path), true);
  assert.equal(readFileSync(path.join(next.path, "node_modules", "dep.js"), "utf8"), "module.exports = 1;\n");
});

test("dropping refuses anything that is not a race checkout", async () => {
  const dir = repo();
  try {
    assert.equal(await dropWorktree(dir), false);
    assert.equal(await dropWorktree(tmpdir()), false);
    assert.equal(await dropWorktree(path.join(tmpdir(), "friday-race-nothex00")), false);
    assert.ok(existsSync(path.join(dir, "a.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a project that doesn't ignore its node_modules keeps seeing it, and nothing is added to its exclude list", { skip: process.platform === "win32" && "a junction is listed as a folder there" }, async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const exclude = path.join(dir, ".git", "info", "exclude");
  const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const copy = await addWorktree(dir, "Claude Code");
  t.after(() => void dropWorktree(copy.path));
  assert.equal(readFileSync(path.join(copy.path, "node_modules", "dep.js"), "utf8"), "module.exports = 1;\n");
  assert.match(git(copy.path, "status", "--porcelain", "--", "node_modules"), /node_modules/, "shown, as the project shows its own");
  assert.equal(existsSync(exclude) ? readFileSync(exclude, "utf8") : "", before);
});
