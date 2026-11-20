import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { make, preview, restack, status } from "../src/runner/stack-pr.js";

const win = process.platform === "win32";
// Real git against a bare "origin" on disk, and a stand-in gh (e2e/fixtures/fake-gh.mjs) that remembers every call.
// A folder name with a space in it: nothing in the runner may rely on paths without one.
const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "friday stack ")));
const ghState = path.join(sandbox, "gh.json");
const oldPath = process.env.PATH;
const home = path.join(sandbox, "home");
before(() => {
  mkdirSync(path.join(sandbox, "bin"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const fake = path.resolve(import.meta.dirname, "..", "e2e", "fixtures", "fake-gh.mjs");
  if (win) {
    // Windows finds gh.cmd on the PATH: the same stand-in behind a batch file.
    writeFileSync(path.join(sandbox, "bin", "gh.cmd"), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    const gh = path.join(sandbox, "bin", "gh");
    writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(gh, 0o755);
  }
  process.env.PATH = [path.join(sandbox, "bin"), oldPath].join(path.delimiter);
  process.env.FAKE_GH_STATE = ghState;
  process.env.GIT_CONFIG_GLOBAL = path.join(home, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
});
after(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_GH_STATE;
  rmSync(sandbox, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const gh = () => JSON.parse(readFileSync(ghState, "utf8")) as { prs: { number: number; base: string; head: string; state: string; body: string; title: string }[]; calls: { args: string[]; body?: string }[] };
const setGh = (f: (s: ReturnType<typeof gh>) => void) => {
  const s = gh();
  f(s);
  writeFileSync(ghState, JSON.stringify(s));
};

/** A repository with an origin and three files on main, the person on `feat` with edits in the folder: a.txt, b.txt changed, d.txt new, c.txt gone. */
function repo(name: string) {
  const origin = path.join(sandbox, `${name}-origin.git`);
  const work = path.join(sandbox, name);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(path.join(work, f), `${f} one\n`);
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
  git(work, "push", "-q", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  git(work, "switch", "-qc", "feat");
  writeFileSync(path.join(work, "a.txt"), "a.txt one\nand two\n");
  writeFileSync(path.join(work, "b.txt"), "b.txt one\nand two\n");
  writeFileSync(path.join(work, "d.txt"), "new file\n");
  rmSync(path.join(work, "c.txt"));
  return { origin, work };
}
const PLAN = { parts: [{ title: "Change a", why: "The base.", files: ["a.txt"] }, { title: "Change b, add d", why: "On top.", files: ["b.txt", "d.txt"] }, { title: "Drop c", why: "Last.", files: ["c.txt"] }] };

test("making the stack builds each branch on the one below without touching the person's checkout, then pushes and opens the pull requests in order", async () => {
  const { origin, work } = repo("make");
  writeFileSync(ghState, JSON.stringify({ prs: [], calls: [] }));
  const before = { head: git(work, "rev-parse", "HEAD"), branch: git(work, "branch", "--show-current"), status: git(work, "status", "--porcelain") };

  const seen = await preview({ root: work, plan: PLAN });
  assert.deepEqual([seen.branch, seen.base, seen.names, seen.skipped, seen.left, seen.remote, seen.gh.ok], ["feat", "main", ["feat-1", "feat-2", "feat-3"], [], [], true, true]);

  setGh((g) => {
    g.calls = [];
  });
  const made = await make({ root: work, plan: PLAN });
  assert.deepEqual(made.parts.map((p) => [p.branch, p.created, p.number]), [["feat-1", true, 1], ["feat-2", true, 2], ["feat-3", true, 3]]);
  // Each part is one commit on the one below; the first is on the base.
  const main = git(work, "rev-parse", "main");
  assert.equal(git(work, "rev-parse", "feat-1^"), main);
  assert.equal(git(work, "rev-parse", "feat-2^"), git(work, "rev-parse", "feat-1"));
  assert.equal(git(work, "rev-parse", "feat-3^"), git(work, "rev-parse", "feat-2"));
  assert.deepEqual(git(work, "diff", "--name-status", "feat-1^", "feat-1").split("\n"), ["M\ta.txt"]);
  assert.deepEqual(git(work, "diff", "--name-status", "feat-2^", "feat-2").split("\n"), ["M\tb.txt", "A\td.txt"]);
  assert.deepEqual(git(work, "diff", "--name-status", "feat-3^", "feat-3").split("\n"), ["D\tc.txt"]);
  // The top of the stack is the folder, for every file it changed.
  assert.equal(git(work, "show", "feat-3:a.txt"), "a.txt one\nand two");
  assert.equal(git(work, "show", "feat-3:d.txt"), "new file");
  assert.equal(git(work, "ls-tree", "--name-only", "feat-3").includes("c.txt"), false);
  // The person's own branch and files are as they were.
  assert.deepEqual({ head: git(work, "rev-parse", "HEAD"), branch: git(work, "branch", "--show-current"), status: git(work, "status", "--porcelain") }, before);
  assert.match(made.notes.join(" "), /Your own branch, feat, and your files are as they were/);
  // On the remote.
  for (const b of ["feat-1", "feat-2", "feat-3"]) assert.equal(git(origin, "rev-parse", `refs/heads/${b}`), git(work, "rev-parse", b));

  // gh was asked in order: auth, then each pull request bottom first with --base the part below, then each description again.
  const calls = gh().calls.map((c) => c.args);
  const creates = calls.filter((a) => a[1] === "create");
  assert.deepEqual(creates.map((a) => [a[a.indexOf("--head") + 1], a[a.indexOf("--base") + 1]]), [["feat-1", "main"], ["feat-2", "feat-1"], ["feat-3", "feat-2"]]);
  const order = calls.map((a) => (a[0] === "auth" ? "auth" : `${a[1]}`));
  assert.deepEqual(order, ["auth", "create", "create", "create", "edit", "edit", "edit"]);
  const prs = gh().prs;
  assert.match(prs[1]!.body, /Part 2 of 3/);
  assert.match(prs[1]!.body, /1\. \[Change a\]\(https:\/\/github\.com\/acme\/widgets\/pull\/1\)/);
  assert.match(prs[0]!.body, /3\. \[Drop c\]\(https:\/\/github\.com\/acme\/widgets\/pull\/3\)/);

  const st = await status({ root: work });
  assert.equal(st.stacks.length, 1);
  assert.deepEqual(st.stacks[0]!.parts.map((p) => [p.branch, p.pr, p.state, p.checks, p.ahead, p.behind, p.pushed, p.current]), [
    ["feat-1", 1, "open", "pass", 1, 0, true, false],
    ["feat-2", 2, "open", "pass", 1, 0, true, false],
    ["feat-3", 3, "open", "pass", 1, 0, true, false],
  ]);

  // Nothing to do: every part already sits on the one below.
  const again = await restack({ root: work });
  assert.equal(again.ok, true);
  assert.deepEqual(again.parts.map((p) => p.did), ["current", "current", "current"]);
});

test("files the proposal missed go in the last part, files it named that did not change are left out, and one part is not a stack", async () => {
  const { work } = repo("clean");
  writeFileSync(ghState, JSON.stringify({ prs: [], calls: [] }));
  const plan = { parts: [{ title: "A", why: "", files: ["a.txt", "nope.txt"] }, { title: "B", why: "", files: ["b.txt"] }] };
  const seen = await preview({ root: work, plan });
  assert.deepEqual([seen.skipped, seen.left], [["nope.txt"], ["c.txt", "d.txt"]]);
  const made = await make({ root: work, plan });
  assert.match(made.notes.join(" "), /2 changed files were not in the proposal/);
  assert.match(made.notes.join(" "), /1 file in the proposal has no changes/);
  assert.deepEqual(git(work, "diff", "--name-status", "feat-2^", "feat-2").split("\n").sort(), ["A\td.txt", "D\tc.txt", "M\tb.txt"]);
  await assert.rejects(make({ root: work, plan: { parts: [{ title: "Only", why: "", files: ["a.txt"] }] }, base: "main" }), /needs two|Only one part/);
});

test("with no gh signed in the branches are pushed and each comes with GitHub's own page for the pull request", async () => {
  const { origin, work } = repo("nogh");
  git(work, "remote", "set-url", "origin", origin);
  writeFileSync(ghState, JSON.stringify({ prs: [], calls: [] }));
  process.env.FAKE_GH_AUTH = "no";
  try {
    const seen = await preview({ root: work, plan: PLAN });
    assert.equal(seen.gh.ok, false);
    const made = await make({ root: work, plan: PLAN });
    assert.equal(made.parts.every((p) => !p.created && p.error), true);
    assert.equal(git(origin, "rev-parse", "refs/heads/feat-1"), git(work, "rev-parse", "feat-1"));
    assert.equal(gh().calls.some((c) => c.args[1] === "create"), false, "no pull request was tried without a login");
  } finally {
    delete process.env.FAKE_GH_AUTH;
  }
});

test("a push the remote refuses on the first branch leaves no branches behind", async () => {
  const { origin, work } = repo("refuse");
  writeFileSync(ghState, JSON.stringify({ prs: [], calls: [] }));
  // A hook on the remote that refuses everything.
  writeFileSync(path.join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'no pushes today' >&2\nexit 1\n");
  chmodSync(path.join(origin, "hooks", "pre-receive"), 0o755);
  await assert.rejects(make({ root: work, plan: PLAN }), /no pushes today/);
  assert.equal(git(work, "branch", "--list", "feat-*"), "");
  assert.equal((await status({ root: work })).stacks.length, 0);
});

test("restack: a changed bottom moves every part above it, a conflict stops and hands over, a merged part drops out", async () => {
  const { origin, work } = repo("restack");
  writeFileSync(ghState, JSON.stringify({ prs: [], calls: [] }));
  await make({ root: work, plan: PLAN });
  const amend = (branch: string, file: string, text: string, msg: string) => {
    // A change on a part, made in a copy of its own so the person's folder stays as it is.
    const wt = path.join(sandbox, `wt-${branch}-${Math.random().toString(16).slice(2)}`);
    git(work, "worktree", "add", "-q", wt, branch);
    writeFileSync(path.join(wt, file), text);
    git(wt, "add", ".");
    git(wt, "commit", "-qm", msg);
    git(work, "worktree", "remove", "--force", wt);
  };

  // A review fix on part 1 (a new file part 2 doesn't touch).
  amend("feat-1", "e.txt", "from review\n", "Review fix");
  const behind = (await status({ root: work })).stacks[0]!.parts;
  assert.deepEqual(behind.map((p) => p.behind), [0, 1, 0], "part 2 says it is one behind");
  const r = await restack({ root: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.parts.map((p) => [p.branch, p.did, p.pushed]), [["feat-1", "current", true], ["feat-2", "rebased", true], ["feat-3", "rebased", true]]);
  assert.equal(git(work, "merge-base", "--is-ancestor", "feat-1", "feat-2") + git(work, "merge-base", "--is-ancestor", "feat-2", "feat-3"), "");
  assert.equal(git(work, "rev-parse", "feat-2^"), git(work, "rev-parse", "feat-1"));
  assert.equal(git(work, "rev-parse", "feat-3^"), git(work, "rev-parse", "feat-2"));
  for (const b of ["feat-1", "feat-2", "feat-3"]) assert.equal(git(origin, "rev-parse", `refs/heads/${b}`), git(work, "rev-parse", b), `${b} pushed`);
  assert.equal(git(work, "branch", "--show-current"), "feat", "the person's branch was never switched");
  assert.equal((await status({ root: work })).stacks[0]!.parts.every((p) => p.behind === 0), true);

  // A change on part 1 that part 2 can't sit on: the restack stops there, changing nothing on part 2.
  amend("feat-1", "b.txt", "b.txt one\nconflicting\n", "A different second line");
  const tip2 = git(work, "rev-parse", "feat-2");
  const tip3 = git(work, "rev-parse", "feat-3");
  const c = await restack({ root: work });
  assert.equal(c.ok, false);
  assert.equal(c.conflict?.part, 2);
  assert.deepEqual(c.conflict?.files, ["b.txt"]);
  assert.match(c.conflict!.handoff, /^Restack part 2 of 3\n/);
  assert.match(c.conflict!.handoff, /`b\.txt`/);
  assert.equal(git(work, "rev-parse", "feat-2"), tip2);
  assert.equal(git(work, "rev-parse", "feat-3"), tip3);
  assert.equal(git(work, "worktree", "list").split("\n").length, 1, "no leftover worktree");
  assert.equal(git(work, "status", "--porcelain").includes("UU"), false);

  // The agent takes it from there: part 2 rebased on part 1 in a copy of its own, the conflict settled, the branch moved.
  const fixer = path.join(sandbox, "wt-resolve");
  git(work, "worktree", "add", "-q", "--detach", fixer, "feat-2");
  try {
    execFileSync("git", ["rebase", "feat-1"], { cwd: fixer, stdio: "ignore" });
  } catch {
    // The conflict it was handed.
  }
  writeFileSync(path.join(fixer, "b.txt"), "b.txt one\nconflicting\nand two\n");
  git(fixer, "add", "b.txt");
  execFileSync("git", ["rebase", "--continue"], { cwd: fixer, stdio: "ignore", env: { ...process.env, GIT_EDITOR: "true" } });
  git(work, "branch", "-f", "feat-2", git(fixer, "rev-parse", "HEAD"));
  git(work, "worktree", "remove", "--force", fixer);
  const after = await restack({ root: work });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.deepEqual(after.parts.map((p) => p.did), ["current", "current", "rebased"], "part 2 already sits on part 1; part 3 follows it");

  // Part 1 merges into main (squashed: no commit of its own on main). Part 2 and 3 are restacked onto main without it.
  const other = path.join(sandbox, "restack-other");
  execFileSync("git", ["clone", "-q", origin, other], { stdio: "ignore" });
  git(other, "merge", "--squash", "origin/feat-1");
  git(other, "commit", "-qm", "Change a (squashed)");
  git(other, "push", "-q", "origin", "main");
  setGh((g) => {
    g.prs[0]!.state = "MERGED";
  });
  const m = await restack({ root: work });
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.deepEqual(m.parts.map((p) => p.did).slice(0, 1), ["merged"]);
  const prs = gh().prs;
  assert.equal(prs[1]!.base, "main", "part 2's pull request now merges into main");
  assert.equal(prs[2]!.base, "feat-2");
  assert.equal(git(work, "merge-base", "--is-ancestor", "origin/main", "feat-2"), "");
  assert.equal(git(work, "show", "feat-3:b.txt"), "b.txt one\nconflicting\nand two");
  const st = (await status({ root: work })).stacks[0]!.parts;
  assert.deepEqual(st.map((p) => p.state), ["merged", "open", "open"]);
});

/** A commit on a part, made in a copy of its own so the person's folder stays as it is. */
function amend(work: string, branch: string, file: string, text: string, msg: string) {
  const wt = path.join(sandbox, `wt-${branch}-${Math.random().toString(16).slice(2)}`);
  git(work, "worktree", "add", "-q", wt, branch);
  writeFileSync(path.join(wt, file), text);
  git(wt, "add", ".");
  git(wt, "commit", "-qm", msg);
  git(work, "worktree", "remove", "--force", wt);
}
/** A second clone (a reviewer, "Commit suggestion", a teammate) pushing a commit to a branch of origin. */
function pushFrom(origin: string, name: string, branch: string, file: string, text: string): string {
  const other = path.join(sandbox, `${name}-other-${Math.random().toString(16).slice(2)}`);
  execFileSync("git", ["clone", "-q", origin, other], { stdio: "ignore" });
  git(other, "switch", "-q", branch);
  writeFileSync(path.join(other, file), text);
  git(other, "add", ".");
  git(other, "commit", "-qm", "Apply suggestion");
  git(other, "push", "-q", "origin", branch);
  return git(other, "rev-parse", "HEAD");
}
const fresh = () => writeFileSync(ghState, JSON.stringify({ prs: [], calls: [] }));

test("a part that needs no rebase is pushed even when it is checked out in the folder, with a review fix committed on it", async () => {
  const { origin, work } = repo("checked");
  fresh();
  await make({ root: work, plan: PLAN });
  git(work, "stash", "-u", "-q");
  git(work, "switch", "-q", "feat-1");
  writeFileSync(path.join(work, "e.txt"), "review fix\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "Review fix");
  const r = await restack({ root: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.parts.map((p) => [p.did, p.pushed]), [["current", true], ["rebased", true], ["rebased", true]]);
  assert.equal(git(work, "branch", "--show-current"), "feat-1", "the folder stayed on its branch");
  for (const b of ["feat-1", "feat-2", "feat-3"]) assert.equal(git(origin, "rev-parse", `refs/heads/${b}`), git(work, "rev-parse", b));
  assert.equal(git(work, "rev-parse", "feat-2^"), git(work, "rev-parse", "feat-1"));
});

test("a part that has to move is not moved under the folder that has it checked out, and the message names the folder", async () => {
  const { work } = repo("checked-move");
  fresh();
  await make({ root: work, plan: PLAN });
  amend(work, "feat-1", "e.txt", "from review\n", "Review fix");
  git(work, "stash", "-u", "-q");
  git(work, "switch", "-q", "feat-2");
  const r = await restack({ root: work });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /feat-2 is checked out in .*checked-move/);
});

test("commits only the remote has (a suggestion committed in review) are kept, never overwritten by a restack", async () => {
  const { origin, work } = repo("remote-ahead");
  fresh();
  await make({ root: work, plan: PLAN });
  const theirs = pushFrom(origin, "remote-ahead", "feat-2", "review.txt", "from the reviewer\n");
  // Nothing to rebase: still, their commit stays on origin and comes here.
  const r = await restack({ root: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(git(origin, "rev-parse", "refs/heads/feat-2"), theirs, "the reviewer's commit is still on origin");
  assert.equal(git(work, "rev-parse", "feat-2"), theirs, "and it is here now");
  assert.match(r.notes.join(" "), /had commits pushed to GitHub/);

  // And when the part below changes, the part is rebased with their commit in it.
  amend(work, "feat-1", "e.txt", "from review\n", "Review fix");
  const again = await restack({ root: work });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(git(work, "show", "feat-2:review.txt"), "from the reviewer");
  assert.equal(git(origin, "rev-parse", "refs/heads/feat-2"), git(work, "rev-parse", "feat-2"));
  assert.equal(git(work, "rev-parse", "feat-2~2"), git(work, "rev-parse", "feat-1"));
});

test("a part whose remote and local copies have both moved stops the restack and changes nothing", async () => {
  const { origin, work } = repo("diverged");
  fresh();
  await make({ root: work, plan: PLAN });
  const theirs = pushFrom(origin, "diverged", "feat-2", "review.txt", "from the reviewer\n");
  amend(work, "feat-2", "mine.txt", "my own\n", "My own fix");
  const mine = git(work, "rev-parse", "feat-2");
  const tip3 = git(work, "rev-parse", "feat-3");
  const r = await restack({ root: work });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Part 2 \(feat-2\) has commits on GitHub that aren't here/);
  assert.equal(git(origin, "rev-parse", "refs/heads/feat-2"), theirs);
  assert.equal(git(work, "rev-parse", "feat-2"), mine);
  assert.equal(git(work, "rev-parse", "feat-3"), tip3);
});

test("a push that fails after the first part keeps the stack, and Restack finishes it: the rest is pushed and every pull request opened", { skip: win }, async () => {
  const { origin, work } = repo("partial");
  fresh();
  const marker = path.join(sandbox, "partial-refuse");
  writeFileSync(marker, "");
  writeFileSync(path.join(origin, "hooks", "pre-receive"), `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/feat-2 ] && [ -f "${marker}" ]; then echo 'feat-2 refused' >&2; exit 1; fi\ndone\n`);
  chmodSync(path.join(origin, "hooks", "pre-receive"), 0o755);
  await assert.rejects(make({ root: work, plan: PLAN }), /Pushed 1 of 3 parts, then: .*feat-2 refused.*Finish the stack/s);
  assert.equal(gh().prs.length, 0);
  assert.equal((await status({ root: work })).stacks[0]!.parts.map((p) => p.pushed).join(), "true,false,false");
  rmSync(marker);
  const r = await restack({ root: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.parts.map((p) => [p.did, p.pushed, p.number]), [["current", false, 1], ["current", true, 2], ["current", true, 3]]);
  assert.deepEqual(gh().prs.map((p) => [p.head, p.base]), [["feat-1", "main"], ["feat-2", "feat-1"], ["feat-3", "feat-2"]]);
  assert.match(gh().prs[0]!.body, /2\. \[Change b, add d\]\(https:\/\/github\.com\/acme\/widgets\/pull\/2\)/);
  for (const b of ["feat-1", "feat-2", "feat-3"]) assert.equal(git(origin, "rev-parse", `refs/heads/${b}`), git(work, "rev-parse", b));
  // Pressing it again opens nothing twice.
  await restack({ root: work });
  assert.equal(gh().prs.length, 3);
});

test("a pull request that gh could not open once is opened by the next restack", async () => {
  const { work } = repo("late-pr");
  fresh();
  process.env.FAKE_GH_AUTH = "no";
  try {
    const made = await make({ root: work, plan: PLAN });
    assert.equal(made.parts.every((p) => !p.created), true);
  } finally {
    delete process.env.FAKE_GH_AUTH;
  }
  assert.equal(gh().prs.length, 0);
  const r = await restack({ root: work });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(gh().prs.map((p) => [p.head, p.base]), [["feat-1", "main"], ["feat-2", "feat-1"], ["feat-3", "feat-2"]]);
  assert.match(r.notes.join(" "), /Opened the pull request for part 1: #1/);
});

test("a rebase that fails for a reason other than a conflict is said in git's words, not handed over as a conflict", { skip: win }, async () => {
  const { work } = repo("hook");
  fresh();
  await make({ root: work, plan: PLAN });
  amend(work, "feat-1", "e.txt", "from review\n", "Review fix");
  const hook = path.join(work, ".git", "hooks", "pre-rebase");
  writeFileSync(hook, "#!/bin/sh\necho 'rebase hook says no' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const tip2 = git(work, "rev-parse", "feat-2");
  const r = await restack({ root: work });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, undefined);
  assert.match(r.error ?? "", /Part 2 \(feat-2\) couldn't be rebased onto feat-1: .*rebase hook says no/);
  assert.equal(git(work, "rev-parse", "feat-2"), tip2);
  assert.equal(git(work, "worktree", "list").split("\n").length, 1);
});

test("a part's commit is what git add would make: the executable bit, a symlink, a submodule pointer left alone", { skip: win }, async () => {
  const { work } = repo("modes");
  fresh();
  chmodSync(path.join(work, "b.txt"), 0o755);
  symlinkSync("a.txt", path.join(work, "link"));
  // A nested repository (git add records it as a pointer) beside the other changes.
  const nested = path.join(work, "vendor");
  mkdirSync(nested);
  execFileSync("git", ["init", "-q", nested]);
  writeFileSync(path.join(nested, "x"), "x");
  execFileSync("git", ["add", "."], { cwd: nested });
  execFileSync("git", ["commit", "-qm", "x"], { cwd: nested });
  await make({ root: work, plan: { parts: [{ title: "A", why: "", files: ["a.txt", "link"] }, { title: "B", why: "", files: ["b.txt", "d.txt"] }] } });
  const tree = git(work, "ls-tree", "feat-2");
  assert.match(tree, /^100755 blob \w+\tb\.txt$/m, "the executable bit is kept");
  assert.match(tree, /^120000 blob \w+\tlink$/m);
  assert.match(tree, new RegExp(`^160000 commit ${git(nested, "rev-parse", "HEAD")}\\tvendor$`, "m"), "the nested repository is a pointer, not a removal");
  // The top of the stack is what `git add -A` would make of the folder.
  git(work, "add", "-A");
  assert.equal(git(work, "write-tree"), git(work, "rev-parse", "feat-2^{tree}"));
});

test("with gh signed out, the Stack view's status does not ask gh for every part again", async () => {
  const { work } = repo("gh-down");
  fresh();
  process.env.FAKE_GH_AUTH = "no";
  try {
    await make({ root: work, plan: PLAN });
    setGh((g) => {
      g.calls = [];
    });
    await status({ root: work });
    await status({ root: work });
    assert.equal(gh().calls.length, 0);
  } finally {
    delete process.env.FAKE_GH_AUTH;
  }
});

test("a restack in a subfolder of the repository works from the repository's top", async () => {
  const { work } = repo("sub");
  fresh();
  mkdirSync(path.join(work, "pkg"));
  writeFileSync(path.join(work, "pkg", "z.txt"), "z\n");
  const made = await make({ root: path.join(work, "pkg"), plan: { parts: [{ title: "Z", why: "", files: ["z.txt"] }, { title: "Rest", why: "", files: ["a.txt", "b.txt"] }] } });
  assert.equal(made.parts.length, 2);
  assert.equal(git(work, "show", "feat-1:pkg/z.txt"), "z");
  assert.equal(existsSync(path.join(work, "pkg", "z.txt")), true);
  const r = await restack({ root: path.join(work, "pkg") });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("a folder that is not a repository, or an ask for another folder, is refused plainly", async () => {
  const dir = mkdtempSync(path.join(sandbox, "plain-"));
  await assert.rejects(preview({ root: dir, plan: PLAN }), /isn't a git repository/);
  await assert.rejects(status({ root: "relative/path" }), /absolute path/);
  await assert.rejects(restack({ root: dir }), /isn't a git repository/);
});
