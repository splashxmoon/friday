import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDE_GIT, parseStatus } from "../src/runner/ide-git.js";

// Isolate from the machine's own git config and Friday home: the trash goes to a temp HOME.
const base = realpathSync(mkdtempSync(join(tmpdir(), "ide-git-")));
const home = join(base, "home");
mkdirSync(home);
writeFileSync(join(base, "gitconfig"), "");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

after(() => rmSync(base, { recursive: true, force: true }));

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const H = IDE_GIT as Required<typeof IDE_GIT>;
let n = 0;

function repo(opts: { identity?: boolean } = {}): string {
  const dir = join(base, `r${n++}`);
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "main");
  if (opts.identity !== false) {
    g(dir, "config", "user.name", "Test User");
    g(dir, "config", "user.email", "test@example.com");
  }
  g(dir, "config", "commit.gpgsign", "false");
  g(dir, "config", "user.useConfigOnly", "true");
  return dir;
}
const put = (dir: string, rel: string, text: string) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const seed = (dir: string) => {
  put(dir, "a.txt", "one\ntwo\n");
  put(dir, "b.txt", "bee\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "first");
};
const byPath = <T extends { path: string }>(files: T[], p: string) => files.find((f) => f.path === p);

test("status: not a repository", async () => {
  const dir = join(base, "plain");
  mkdirSync(dir);
  const s = await H["git.status"]({ root: dir });
  assert.equal(s.repo, false);
  assert.deepEqual(s.files, []);
});

test("status: rejects a relative or missing root", async () => {
  await assert.rejects(H["git.status"]({ root: "relative/dir" }), /absolute/);
  await assert.rejects(H["git.status"]({ root: join(base, "nope") }), /doesn't exist/);
});

test("init makes a repository", async () => {
  const dir = join(base, "toinit");
  mkdirSync(dir);
  await H["git.init"]({ root: dir });
  assert.equal((await H["git.status"]({ root: dir })).repo, true);
});

test("status: modified, added, deleted, untracked, branch", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "a.txt", "one\nTWO\n");
  put(dir, "new dir/with space.txt", "x");
  g(dir, "rm", "-q", "b.txt");
  const s = await H["git.status"]({ root: dir });
  assert.equal(s.repo, true);
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, null);
  assert.deepEqual(byPath(s.files, "a.txt"), { path: "a.txt", index: null, work: "M" });
  assert.deepEqual(byPath(s.files, "b.txt"), { path: "b.txt", index: "D", work: null });
  assert.deepEqual(byPath(s.files, "new dir/with space.txt"), { path: "new dir/with space.txt", index: null, work: "?" });
});

test("status: a rename carries where it came from", async () => {
  const dir = repo();
  seed(dir);
  g(dir, "mv", "a.txt", "renamed.txt");
  const s = await H["git.status"]({ root: dir });
  assert.deepEqual(byPath(s.files, "renamed.txt"), { path: "renamed.txt", from: "a.txt", index: "R", work: null });
  assert.equal(byPath(s.files, "a.txt"), undefined);
});

test("status: an unmerged conflict shows as U", async () => {
  const dir = repo();
  seed(dir);
  g(dir, "switch", "-q", "-c", "other");
  put(dir, "a.txt", "other side\ntwo\n");
  g(dir, "commit", "-q", "-am", "other");
  g(dir, "switch", "-q", "main");
  put(dir, "a.txt", "main side\ntwo\n");
  g(dir, "commit", "-q", "-am", "main");
  try { g(dir, "merge", "other"); } catch { /* conflicts are the point */ }
  const s = await H["git.status"]({ root: dir });
  assert.deepEqual(byPath(s.files, "a.txt"), { path: "a.txt", index: null, work: "U" });
});

test("status: ahead and behind of the upstream", async () => {
  const remote = join(base, `bare${n++}.git`);
  mkdirSync(remote);
  g(remote, "init", "-q", "--bare", "-b", "main");
  const dir = repo();
  seed(dir);
  g(dir, "remote", "add", "origin", remote);
  g(dir, "push", "-q", "-u", "origin", "main");
  put(dir, "c.txt", "c");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "local");
  const s = await H["git.status"]({ root: dir });
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 0);
});

test("status: a folder inside a repository gets paths relative to itself", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "sub/x.txt", "x");
  put(dir, "a.txt", "changed\n");
  const s = await H["git.status"]({ root: join(dir, "sub") });
  assert.deepEqual(s.files.map((f) => f.path), ["x.txt"]);
});

test("parseStatus: detached head and an unborn branch", () => {
  const d = parseStatus("# branch.oid 1234567890abcdef\0# branch.head (detached)\0");
  assert.equal(d.branch, "1234567");
  const u = parseStatus("# branch.oid (initial)\0# branch.head main\0? f.txt\0");
  assert.equal(u.branch, "main");
  assert.deepEqual(u.files, [{ path: "f.txt", index: null, work: "?" }]);
});

test("diff: unstaged change compares HEAD with the working file", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "a.txt", "one\nTWO\n");
  const d = await H["git.diff"]({ root: dir, path: "a.txt" });
  assert.deepEqual(d, { original: "one\ntwo\n", modified: "one\nTWO\n", binary: false });
});

test("diff: staged and unstaged edits of the same file are separate", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "a.txt", "one\nSTAGED\n");
  g(dir, "add", "a.txt");
  put(dir, "a.txt", "one\nSTAGED\nlater\n");
  const staged = await H["git.diff"]({ root: dir, path: "a.txt", staged: true });
  assert.equal(staged.original, "one\ntwo\n");
  assert.equal(staged.modified, "one\nSTAGED\n");
  const work = await H["git.diff"]({ root: dir, path: "a.txt" });
  assert.equal(work.original, "one\nSTAGED\n");
  assert.equal(work.modified, "one\nSTAGED\nlater\n");
});

test("diff: added, deleted and untracked sides are empty", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "u.txt", "untracked\n");
  assert.deepEqual(await H["git.diff"]({ root: dir, path: "u.txt" }), { original: "", modified: "untracked\n", binary: false });
  g(dir, "add", "u.txt");
  assert.deepEqual(await H["git.diff"]({ root: dir, path: "u.txt", staged: true }), { original: "", modified: "untracked\n", binary: false });
  rmSync(join(dir, "b.txt"));
  assert.deepEqual(await H["git.diff"]({ root: dir, path: "b.txt" }), { original: "bee\n", modified: "", binary: false });
});

test("diff: binary files are flagged, CRLF kept", async () => {
  const dir = repo();
  seed(dir);
  writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  assert.equal((await H["git.diff"]({ root: dir, path: "img.bin" })).binary, true);
  put(dir, "crlf.txt", "a\r\nb\r\n");
  assert.equal((await H["git.diff"]({ root: dir, path: "crlf.txt" })).modified, "a\r\nb\r\n");
});

test("diff: refuses a path outside the folder", async () => {
  const dir = repo();
  seed(dir);
  await assert.rejects(H["git.diff"]({ root: dir, path: "../x" }), /outside/);
  await assert.rejects(H["git.stage"]({ root: dir, paths: ["../../etc/passwd"] }), /outside/);
});

test("stage and unstage, including a never-committed repository", async () => {
  const dir = repo();
  put(dir, "f.txt", "f");
  await H["git.stage"]({ root: dir, paths: ["f.txt"] });
  assert.equal(byPath((await H["git.status"]({ root: dir })).files, "f.txt")?.index, "A");
  await H["git.unstage"]({ root: dir, paths: ["f.txt"] });
  assert.deepEqual(byPath((await H["git.status"]({ root: dir })).files, "f.txt"), { path: "f.txt", index: null, work: "?" });
  seed(dir);
  put(dir, "a.txt", "changed\n");
  rmSync(join(dir, "b.txt"));
  await H["git.stage"]({ root: dir, paths: ["a.txt", "b.txt"] });
  let s = await H["git.status"]({ root: dir });
  assert.equal(byPath(s.files, "a.txt")?.index, "M");
  assert.equal(byPath(s.files, "b.txt")?.index, "D");
  await H["git.unstage"]({ root: dir, paths: ["a.txt", "b.txt"] });
  s = await H["git.status"]({ root: dir });
  assert.deepEqual(byPath(s.files, "a.txt"), { path: "a.txt", index: null, work: "M" });
  assert.deepEqual(byPath(s.files, "b.txt"), { path: "b.txt", index: null, work: "D" });
});

test("unstaging a rename puts the old name back too", async () => {
  const dir = repo();
  seed(dir);
  g(dir, "mv", "a.txt", "z.txt");
  await H["git.unstage"]({ root: dir, paths: ["z.txt"] });
  const s = await H["git.status"]({ root: dir });
  assert.deepEqual(byPath(s.files, "a.txt"), { path: "a.txt", index: null, work: "D" });
  assert.deepEqual(byPath(s.files, "z.txt"), { path: "z.txt", index: null, work: "?" });
});

test("discard restores tracked files and trashes untracked ones", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "a.txt", "changed\n");
  put(dir, "junk/new.txt", "keep me in the trash");
  const r = await H["git.discard"]({ root: dir, paths: ["a.txt", "junk"] });
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\n");
  assert.equal(existsSync(join(dir, "junk/new.txt")), false);
  assert.ok(r.trashed && r.trashed.startsWith(join(home, ".friday", "trash", "ide")));
  assert.equal(readFileSync(join(r.trashed!, "junk/new.txt"), "utf8"), "keep me in the trash");
  assert.equal(readFileSync(join(r.trashed!, "a.txt"), "utf8"), "changed\n", "the discarded edit of a tracked file is kept too");
  assert.deepEqual((await H["git.status"]({ root: dir })).files, []);
});

test("discard leaves a staged-only change alone", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "a.txt", "staged\n");
  g(dir, "add", "a.txt");
  await H["git.discard"]({ root: dir, paths: ["a.txt"] });
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "staged\n");
});

test("commit: staged only, then all, with the errors", async () => {
  const dir = repo();
  seed(dir);
  await assert.rejects(H["git.commit"]({ root: dir, message: "x" }), /nothing to commit/i);
  await assert.rejects(H["git.commit"]({ root: dir, message: "  " }), /message/i);
  put(dir, "a.txt", "A\n");
  put(dir, "b.txt", "B\n");
  g(dir, "add", "a.txt");
  const c1 = await H["git.commit"]({ root: dir, message: "only a\n\nwith \"quotes\" and $(no shell)" });
  assert.equal(c1.sha, g(dir, "rev-parse", "HEAD"));
  assert.equal(g(dir, "log", "-1", "--format=%s"), "only a");
  assert.deepEqual(g(dir, "show", "--name-only", "--format=", "HEAD").split("\n"), ["a.txt"]);
  // Nothing staged now: all stages tracked and untracked changes first.
  put(dir, "new.txt", "n");
  const c2 = await H["git.commit"]({ root: dir, message: "everything", all: true });
  assert.deepEqual(g(dir, "show", "--name-only", "--format=", c2.sha).split("\n").sort(), ["b.txt", "new.txt"]);
  assert.deepEqual((await H["git.status"]({ root: dir })).files, []);
});

test("commit: says so when git doesn't know who you are", async () => {
  const dir = repo({ identity: false });
  put(dir, "a.txt", "a");
  await assert.rejects(H["git.commit"]({ root: dir, message: "x", all: true }), /doesn't know who you are/);
});

test("branches, create and checkout", async () => {
  const dir = repo();
  seed(dir);
  await H["git.checkout"]({ root: dir, branch: "feature/x", create: true });
  let b = await H["git.branches"]({ root: dir });
  assert.equal(b.current, "feature/x");
  assert.deepEqual(b.local.sort(), ["feature/x", "main"]);
  await H["git.checkout"]({ root: dir, branch: "main" });
  b = await H["git.branches"]({ root: dir });
  assert.equal(b.current, "main");
  await assert.rejects(H["git.checkout"]({ root: dir, branch: "bad name", create: true }), /valid branch name/);
  await assert.rejects(H["git.checkout"]({ root: dir, branch: "--orphan" }), /branch name/);
  await assert.rejects(H["git.checkout"]({ root: dir, branch: "nope" }));
});

test("sync: push sets the upstream, fetch and pull follow it, remote branches list and track", async () => {
  const remote = join(base, `bare${n++}.git`);
  mkdirSync(remote);
  g(remote, "init", "-q", "--bare", "-b", "main");
  const a = repo();
  seed(a);
  g(a, "remote", "add", "origin", remote);
  const pushed = await H["git.sync"]({ root: a, action: "push" });
  assert.equal(pushed.ok, true);
  assert.equal((await H["git.status"]({ root: a })).upstream, "origin/main");

  const b = join(base, `clone${n++}`);
  g(base, "clone", "-q", remote, b);
  g(b, "config", "user.name", "B");
  g(b, "config", "user.email", "b@example.com");
  g(b, "config", "commit.gpgsign", "false");
  put(b, "from-b.txt", "b");
  g(b, "add", "-A");
  g(b, "commit", "-q", "-m", "from b");
  g(b, "switch", "-q", "-c", "topic");
  g(b, "push", "-q", "origin", "main", "topic");

  await H["git.sync"]({ root: a, action: "fetch" });
  let s = await H["git.status"]({ root: a });
  assert.equal(s.behind, 1);
  const br = await H["git.branches"]({ root: a });
  assert.ok(br.remote.includes("origin/topic"));
  assert.ok(!br.remote.some((r) => r.endsWith("/HEAD")));

  const pulled = await H["git.sync"]({ root: a, action: "pull" });
  assert.equal(pulled.ok, true);
  assert.equal(readFileSync(join(a, "from-b.txt"), "utf8"), "b");
  s = await H["git.status"]({ root: a });
  assert.equal(s.behind, 0);

  await H["git.checkout"]({ root: a, branch: "origin/topic" });
  assert.equal((await H["git.branches"]({ root: a })).current, "topic");
  await assert.rejects(H["git.sync"]({ root: a, action: "rebase" as "pull" }), /Unknown sync/);
});

test("log: newest first, and --follow carries a file across a rename", async () => {
  const dir = repo();
  put(dir, "old.txt", "1\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "add old");
  put(dir, "other.txt", "o\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "unrelated");
  g(dir, "mv", "old.txt", "new.txt");
  g(dir, "commit", "-q", "-m", "rename it");
  put(dir, "new.txt", "1\n2\n");
  g(dir, "commit", "-q", "-am", "edit new");
  const all = await H["git.log"]({ root: dir });
  assert.deepEqual(all.commits.map((c) => c.subject), ["edit new", "rename it", "unrelated", "add old"]);
  assert.equal(all.commits[0].author, "Test User");
  assert.ok(Math.abs(all.commits[0].at - Date.now() / 1000) < 120);
  assert.equal(all.commits[0].sha, g(dir, "rev-parse", "HEAD"));
  const file = await H["git.log"]({ root: dir, path: "new.txt" });
  assert.deepEqual(file.commits.map((c) => c.subject), ["edit new", "rename it", "add old"]);
  assert.equal((await H["git.log"]({ root: dir, max: 2 })).commits.length, 2);
});

test("log: a repository with no commits is an empty list", async () => {
  const dir = repo();
  assert.deepEqual(await H["git.log"]({ root: dir }), { commits: [] });
});

test("discarding a tracked change keeps the edit in the trash", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "a.txt", "x\n");
  const r = await H["git.discard"]({ root: dir, paths: ["a.txt"] });
  assert.equal(readFileSync(join(r.trashed!, "a.txt"), "utf8"), "x\n");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\n");
});

test("commit from a subfolder takes only that folder, and refuses staged changes elsewhere", async () => {
  const dir = repo();
  put(dir, "pkg/in.txt", "1\n");
  put(dir, "other/out.txt", "1\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "first");
  const pkg = join(dir, "pkg");
  put(dir, "pkg/in.txt", "2\n");
  put(dir, "other/out.txt", "2\n");
  // Commit All in pkg stages pkg only.
  const c = await H["git.commit"]({ root: pkg, message: "pkg only", all: true });
  assert.deepEqual(g(dir, "show", "--name-only", "--format=", c.sha).split("\n"), ["pkg/in.txt"]);
  assert.equal((await H["git.status"]({ root: dir })).files.length, 1, "the other folder's change is still waiting");
  // Staged elsewhere: the commit is refused and names the file, and nothing is committed.
  put(dir, "pkg/in.txt", "3\n");
  g(dir, "add", "-A");
  const before = g(dir, "rev-parse", "HEAD");
  await assert.rejects(H["git.commit"]({ root: pkg, message: "x" }), /outside this folder.*other\/out\.txt/);
  assert.equal(g(dir, "rev-parse", "HEAD"), before);
  // Nothing staged inside the folder is "nothing to commit", even if the repository has staged files.
  g(dir, "reset", "-q");
  g(dir, "add", "other/out.txt");
  await assert.rejects(H["git.commit"]({ root: pkg, message: "x" }), /nothing to commit/i);
});

test("checkout: full remote names, ambiguous bare names, option-like names", async () => {
  const dir = repo();
  seed(dir);
  const a = join(base, `remote${n++}`);
  const b = join(base, `remote${n++}`);
  for (const r of [a, b]) { mkdirSync(r); g(r, "init", "-q", "--bare"); }
  g(dir, "remote", "add", "one", a);
  g(dir, "remote", "add", "two", b);
  g(dir, "switch", "-q", "-c", "feat");
  put(dir, "f.txt", "f\n");
  g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", "feat");
  g(dir, "push", "-q", "one", "feat");
  g(dir, "push", "-q", "two", "feat");
  g(dir, "switch", "-q", "main");
  g(dir, "branch", "-q", "-D", "feat");
  g(dir, "fetch", "-q", "--all");
  await assert.rejects(H["git.checkout"]({ root: dir, branch: "feat" }), /More than one remote/);
  await assert.rejects(H["git.checkout"]({ root: dir, branch: " --detach" }), /isn't a branch name/);
  await H["git.checkout"]({ root: dir, branch: "two/feat" });
  assert.equal(g(dir, "rev-parse", "--abbrev-ref", "feat@{u}"), "two/feat");
});

test("push with no upstream goes to the only remote, not a hard-coded origin", async () => {
  const dir = repo();
  seed(dir);
  const r = join(base, `remote${n++}`);
  mkdirSync(r); g(r, "init", "-q", "--bare");
  await assert.rejects(H["git.sync"]({ root: dir, action: "push" }), /no remote/i);
  g(dir, "remote", "add", "upstream", r);
  await H["git.sync"]({ root: dir, action: "push" });
  assert.equal(g(dir, "rev-parse", "--abbrev-ref", "main@{u}"), "upstream/main");
});

test("status shares a call in flight and can list untracked folders as one entry", async () => {
  const dir = repo();
  seed(dir);
  put(dir, "newdir/x.txt", "x");
  put(dir, "newdir/y.txt", "y");
  const [all, normal, again] = await Promise.all([
    H["git.status"]({ root: dir }),
    H["git.status"]({ root: dir, untracked: "normal" }),
    H["git.status"]({ root: dir }),
  ]);
  assert.deepEqual(all.files.map((f) => f.path).sort(), ["newdir/x.txt", "newdir/y.txt"]);
  assert.deepEqual(normal.files.map((f) => f.path), ["newdir/"]);
  assert.deepEqual(again, all);
});

test("a diff of a link that leads outside the folder shows nothing of the outside file", { skip: process.platform === "win32" }, async () => {
  const dir = repo();
  seed(dir);
  const outside = join(base, "secret.txt");
  writeFileSync(outside, "top secret\n");
  symlinkSync(outside, join(dir, "peek.txt"));
  const d = await H["git.diff"]({ root: dir, path: "peek.txt" });
  assert.equal(d.modified.includes("secret"), false);
});
