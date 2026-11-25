// What Friday keeps on this computer, kept from piling up (runner/storage.ts; Arun, 2026-11-19: "stuff saved on disk that was
// either deleted or removed ... and it is still there"). Copies no session uses are cleared, or trashed when they hold uncommitted
// work; a session's own, an agent's working one and a spare stay; a test's leftover goes; the trash empties after a week; the
// files lanes left go; screenshots go with their session; and what is kept is measured by kind. All in a home of its own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "friday-storage-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // where Windows reads the home folder from
process.env.FRIDAY_HOME = path.join(home, ".friday");
process.env.FRIDAY_WORKTREES = path.join(home, ".friday", "worktrees");
const { claudeKey, measure, retireCopy, retireOlder, shotSid, tidy } = await import("../src/runner/storage.js");
const { addWorktree, markMadeHere } = await import("../src/runner/git.js");

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

test("tidy: left-behind copies cleared or trashed, kept ones stay, leftovers and old files go", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, "code", "app");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  // Made by this app, as local-api marks them.
  const copy = async (name: string) => {
    const p = (await addWorktree(repo, name)).path;
    await markMadeHere(p);
    return p;
  };
  const unmarked = async (name: string) => (await addWorktree(repo, name)).path;
  const clean = await copy("clean");
  const committed = await copy("committed");
  writeFileSync(path.join(committed, "b.txt"), "b\n");
  git(committed, "add", ".");
  git(committed, "commit", "-qm", "work");
  const branch = git(committed, "rev-parse", "--abbrev-ref", "HEAD");
  const dirty = await copy("dirty");
  writeFileSync(path.join(dirty, "wip.txt"), "unsaved\n");
  const mine = await copy("mine");
  writeFileSync(path.join(mine, "wip.txt"), "a session's own\n");
  const busy = await copy("busy");
  // Made before copies were marked, or by a linked Friday: one touched today stays, one untouched for days waits to be asked about.
  const recent = await unmarked("recent");
  const older = await unmarked("older");
  writeFileSync(path.join(older, "wip.txt"), "old\n");
  const days4 = (Date.now() - 4 * 86_400_000) / 1000;
  const olderGit = git(older, "rev-parse", "--absolute-git-dir");
  for (const p of [older, path.join(olderGit, "index"), path.join(olderGit, "HEAD"), path.join(olderGit, "logs", "HEAD")]) if (existsSync(p)) utimesSync(p, days4, days4);
  // A test's leftover: its repository in the temporary folder, gone.
  const root = process.env.FRIDAY_WORKTREES!;
  const leftover = path.join(root, "friday-busy-abc-1234abcd");
  mkdirSync(leftover, { recursive: true });
  writeFileSync(path.join(leftover, ".git"), `gitdir: ${path.join(tmpdir(), "friday-busy-gone", ".git", "worktrees", "x")}\n`);
  // The trash: one from last week, one from today.
  const trash = path.join(home, ".friday", "trash", "copies");
  mkdirSync(path.join(trash, "old-1"), { recursive: true });
  mkdirSync(path.join(trash, "new-1"), { recursive: true });
  const week = (Date.now() - 8 * 86_400_000) / 1000;
  utimesSync(path.join(trash, "old-1"), week, week);
  // Trashed today though the folder itself is a month old (a move keeps its date): its week counts from its name's time.
  const month = (Date.now() - 30 * 86_400_000) / 1000;
  const today = path.join(trash, `web-0badc0de-${Date.now()}`);
  mkdirSync(today, { recursive: true });
  utimesSync(today, month, month);
  // A skill removed today, its folder a month old; and one removed six weeks ago.
  const skills = path.join(home, ".friday", "trash", "skills");
  const iso = (d: Date) => d.toISOString().replace(/[:.]/g, "-");
  const skillNew = path.join(skills, `review-${iso(new Date())}`);
  const skillOld = path.join(skills, `tdd-${iso(new Date(Date.now() - 42 * 86_400_000))}`);
  mkdirSync(skillNew, { recursive: true });
  mkdirSync(skillOld, { recursive: true });
  utimesSync(skillNew, month, month);
  // Files lanes wrote as they started: one from before this app started, one since.
  const mesh = path.join(home, ".friday", "mesh");
  mkdirSync(mesh, { recursive: true });
  writeFileSync(path.join(mesh, "old.url"), "x");
  utimesSync(path.join(mesh, "old.url"), week, week);
  writeFileSync(path.join(mesh, "new.url"), "x");
  // Screenshots of a session that's gone and one that's here (its id with a "-" in it).
  const shots = path.join(home, ".friday", "shots");
  mkdirSync(shots, { recursive: true });
  writeFileSync(path.join(shots, "gone1234-1794863642300.png"), "");
  writeFileSync(path.join(shots, "a-b_cd12-1794863646069.png"), "");
  assert.equal(shotSid("a-b_cd12-1794863646069.png"), "a-b_cd12");

  const before = await measure(new Set([mine]), new Set([busy]));
  const of = (id: string) => before.piles.find((p) => p.id === id)!;
  assert.equal(of("copies").count, 3, "the session's own, the one an agent works in, and an unmarked one touched today");
  assert.equal(of("leftover").count, 4, "clean, committed, dirty, the test's");
  assert.equal(of("older").count, 1, "the unmarked one untouched for days");
  assert.ok(before.total > 0);
  // What Clean up now would clear this moment: the copies left behind were made just now, so none is a day old yet, and they wait
  // (Arun, 2026-11-20: "grey out the clean up now if nothing is there to clear"); the test's, its repository gone, is new too.
  assert.ok(before.due > 0 && before.due < of("leftover").bytes, "only last week's trash is due: the new copies wait their day");
  assert.equal(before.soon, of("leftover").bytes, "they go by themselves once a day old");

  const r = await tidy({ inUse: new Set([busy]), referenced: new Set([mine]), liveSids: new Set(["a-b_cd12"]), since: Date.now() - 60_000, graceMs: 0 });
  assert.equal(existsSync(clean), false, "a clean copy no session uses is cleared");
  assert.equal(existsSync(committed), false, "so is one whose work is committed");
  assert.equal(git(repo, "rev-parse", "--verify", "-q", branch).length > 0, true, "its branch, and the work on it, stays");
  assert.equal(existsSync(dirty), false, "uncommitted work isn't left in place…");
  const trashed = readdirSync(trash).find((n) => n.startsWith(path.basename(dirty)));
  assert.ok(trashed, "…it is in the trash");
  assert.ok(Date.now() - statSync(path.join(trash, trashed!)).mtimeMs < 60_000, "dated today, so its week starts now");
  assert.equal(existsSync(path.join(trash, trashed!, "wip.txt")), true, "with its changes");
  assert.equal(existsSync(mine), true, "a session's own copy stays, uncommitted work and all");
  assert.equal(existsSync(busy), true, "and the one an agent works in now");
  assert.equal(existsSync(leftover), false, "a test's leftover goes");
  assert.equal(existsSync(path.join(trash, "old-1")), false, "the trash empties after a week");
  assert.equal(existsSync(path.join(trash, "new-1")), true);
  assert.equal(existsSync(today), true, "trashed today: its week hasn't started running out, whatever the folder's own date");
  assert.equal(existsSync(skillNew), true, "a skill removed today stays");
  assert.equal(existsSync(skillOld), false, "one removed six weeks ago goes");
  assert.deepEqual(readdirSync(mesh), ["new.url"], "files from lanes before this app started go");
  assert.deepEqual(readdirSync(shots), ["a-b_cd12-1794863646069.png"], "screenshots go with their session");
  assert.ok(r.dropped >= 3 && r.trashed === 1 && r.purged === 2, JSON.stringify(r));
  assert.equal(git(repo, "worktree", "list").includes(path.basename(dirty)), false, "git forgets the trashed copy");
  assert.equal(existsSync(recent) && existsSync(older), true, "unmarked copies are never put away by themselves");
  // Asked to: the older one goes to the trash (it has uncommitted work); the recent one stays.
  assert.deepEqual(await retireOlder(new Set([mine]), new Set([busy])), { dropped: 0, trashed: 1 });
  assert.equal(existsSync(older), false);
  assert.equal(existsSync(recent), true);

  // Not knowing which sessions exist, nothing counts as left behind.
  const spare = await copy("unknown");
  await tidy({ inUse: new Set(), referenced: null, liveSids: null, since: 0, graceMs: 0 });
  assert.equal(existsSync(spare), true);
  assert.equal(await retireCopy(spare), "dropped");
});

// Arun, 2026-11-24: "friday eats up storage with all of the work trees and past sessions that were deleted". Copies agents make in
// the worktrees folder by a name of their own were never measured or cleared, and Claude Code's records of copies that are gone
// stayed in ~/.claude/projects.
test("tidy: copies agents named themselves count, and conversations of gone copies go to the trash", async (t) => {
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, "code", "edge");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const root = process.env.FRIDAY_WORKTREES!;
  mkdirSync(root, { recursive: true });
  // An agent's own `git worktree add`, under a name Friday didn't give it, untouched for four days; and a plain folder, not a copy.
  const named = path.join(root, "edge-c2-adapt");
  git(repo, "worktree", "add", "-q", "-b", "friday/c2-adapt", named);
  const days4 = (Date.now() - 4 * 86_400_000) / 1000;
  const g = git(named, "rev-parse", "--absolute-git-dir");
  for (const p of [named, path.join(g, "HEAD"), path.join(g, "logs", "HEAD")]) if (existsSync(p)) utimesSync(p, days4, days4);
  mkdirSync(path.join(root, "notes"), { recursive: true });
  const live = (await addWorktree(repo, "live")).path;

  // Claude Code's records: of the live copy and a folder in it (kept), of a copy gone two days (goes), of one gone an hour (waits
  // its day), and of someone's own repository (never touched).
  const projects = path.join(home, ".claude", "projects");
  const rec = (folder: string, ageDays: number) => {
    const at = path.join(projects, claudeKey(folder));
    mkdirSync(at, { recursive: true });
    writeFileSync(path.join(at, "s.jsonl"), "{}\n");
    const when = (Date.now() - ageDays * 86_400_000) / 1000;
    utimesSync(path.join(at, "s.jsonl"), when, when);
    utimesSync(at, when, when);
    return at;
  };
  const keepLive = rec(live, 5);
  const keepInside = rec(path.join(live, "app"), 5);
  const gone = rec(path.join(root, "edge-0badc0de"), 2);
  const fresh = rec(path.join(root, "edge-1badc0de"), 1 / 24);
  const own = rec(repo, 30);

  const m = await measure(new Set([live]), new Set());
  const of = (id: string) => m.piles.find((p) => p.id === id)!;
  assert.equal(of("older").count, 1, "the agent's own copy is measured, as an older copy");
  assert.equal(of("transcripts").count, 1, "the record of the copy gone two days");
  assert.ok(m.due >= of("transcripts").bytes && of("transcripts").bytes > 0);

  await tidy({ inUse: new Set(), referenced: new Set([live]), liveSids: null, since: 0 });
  assert.equal(existsSync(named), true, "an unmarked copy is never put away by itself");
  assert.equal(existsSync(gone), false, "the record of a gone copy leaves ~/.claude…");
  const trashed = readdirSync(path.join(home, ".friday", "trash", "transcripts"));
  assert.equal(trashed.length, 1);
  assert.ok(trashed[0]!.startsWith(path.basename(gone) + "-"), "…for Friday's trash, its week from now");
  assert.equal(existsSync(path.join(home, ".friday", "trash", "transcripts", trashed[0]!, "s.jsonl")), true);
  for (const p of [keepLive, keepInside, fresh, own]) assert.equal(existsSync(p), true, p);

  // Asked to, the agent's copy goes to the trash (Friday deletes outright only the copies it named, git.ts ownTop); its branch stays.
  assert.deepEqual(await retireOlder(new Set([live]), new Set()), { dropped: 0, trashed: 1 });
  assert.equal(existsSync(named), false);
  assert.equal(git(repo, "rev-parse", "--verify", "-q", "friday/c2-adapt").length > 0, true, "its branch stays");
  assert.equal(existsSync(path.join(root, "notes")), true, "a folder that isn't a copy is never touched");
});
