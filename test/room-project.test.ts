import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { branchesAt, cleanProject, notReadyWhy, parseLsRemote, okBranch, projectNote, ready, repoKey, repoName, resolveMember, showProject, type Git } from "../src/room-project.js";
import { cleanRoom } from "../src/teammates.js";

const git: Git = (cwd, args) => new Promise((resolve, reject) => execFile("git", ["-C", cwd, ...args], (e, out) => (e ? reject(e) : resolve(String(out)))));

test("one repo however its remote is written: scp, ssh, https, a trailing slash or .git, and owner/repo for GitHub", () => {
  const want = "github.com/owner/repo";
  for (const r of ["git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo", "https://github.com/Owner/Repo/", "owner/repo", "git+ssh://git@github.com/owner/repo"]) assert.equal(repoKey(r), want, r);
  assert.equal(repoKey("https://gitlab.com/group/sub/repo.git"), "gitlab.com/group/sub/repo");
  for (const r of ["/Users/me/code/repo", "C:\\code\\repo", "C:/code/repo", "./repo", "../x/y", "repo", "file:///tmp/repo", "", "https://github.com/owner"]) assert.equal(repoKey(r), null, r);
});

test("a project is stored canonical, its branch kept, and blank or null is No project", () => {
  assert.deepEqual(cleanProject("Owner/Repo"), { repo: "https://github.com/Owner/Repo" });
  assert.deepEqual(cleanProject({ repo: "git@github.com:owner/repo.git", branch: " main " }), { repo: "https://github.com/owner/repo", branch: "main" });
  assert.deepEqual(cleanProject({ repo: "https://gitlab.com/g/r.git", branch: "" }), { repo: "https://gitlab.com/g/r" });
  assert.equal(cleanProject(null), null);
  assert.equal(cleanProject(""), null);
  assert.equal(cleanProject({ repo: "  " }), null);
  assert.equal(cleanProject(undefined), undefined);
});

test("a folder is taken whole (no branch); ~, a relative path, a sign-in in the address, or a bad branch is refused", () => {
  // Arun, 2026-11-17: "also add support for folders too".
  assert.deepEqual(cleanProject({ repo: "/Users/me/code/notes/", branch: "main" }), { repo: "/Users/me/code/notes" });
  assert.deepEqual(cleanProject("C:\\code\\notes"), { repo: "C:\\code\\notes" });
  assert.throws(() => cleanProject("/Users/me/../etc"), /isn't a folder Friday can use/);
  assert.throws(() => cleanProject("~/code/repo"), /pick the folder whole/);
  assert.throws(() => cleanProject("./repo"), /pick the folder whole/);
  assert.throws(() => cleanProject("https://ghp_abc123@github.com/owner/repo"), /sign-in/);
  assert.throws(() => cleanProject("https://me:secret@github.com/owner/repo"), /sign-in/);
  assert.throws(() => cleanProject("me:secret@github.com:owner/repo"), /sign-in/);
  assert.throws(() => cleanProject("not a repo"), /isn't a repo/);
  assert.throws(() => cleanProject({ repo: "owner/repo", branch: "has space" }), /branch name/);
  assert.ok(okBranch("feature/new-pricing") && !okBranch("a..b") && !okBranch("-x") && !okBranch("x.lock"));
});

test("a folder project: everyone on its computer works in it, while it is there", async () => {
  const p = { repo: "/Users/me/notes" };
  assert.equal(showProject(p), "notes · folder");
  const git = async () => "";
  assert.deepEqual(await resolveMember(p, { projects: [] }, git, async () => true), { state: "resolved", path: "/Users/me/notes" });
  assert.deepEqual(await resolveMember(p, { projects: [] }, git, async () => false), { state: "unresolved" });
  assert.match(projectNote(p, { state: "resolved", path: p.repo }), /folder \/Users\/me\/notes: work on the project there/);
  assert.match(notReadyWhy({ state: "unresolved" }, p), /can't reach the folder/);
});

test("shown as owner/repo · branch, or · default with none, never a guessed default", () => {
  assert.equal(showProject({ repo: "https://github.com/owner/repo", branch: "main" }), "owner/repo · main");
  assert.equal(showProject({ repo: "https://github.com/owner/repo" }), "owner/repo · default");
  assert.equal(repoName("https://gitlab.com/g/r"), "gitlab.com/g/r");
});

test("cleanRoom takes a project, and null clears it", () => {
  assert.deepEqual(cleanRoom({ project: { repo: "owner/repo", branch: "main" } }, []).project, { repo: "https://github.com/owner/repo", branch: "main" });
  assert.equal(cleanRoom({ project: null }, []).project, null);
  assert.equal("project" in cleanRoom({ name: "x" }, []), false);
});

async function repo(dir: string, remote: string, branches: string[] = []) {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "trunk"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
  await git(dir, ["remote", "add", "origin", remote]);
  for (const b of branches) await git(dir, ["branch", b]);
  return realpath(dir);
}

test("each crew mate resolves to its own copy: project folders first, then its own folder; two copies are ambiguous; none is unresolved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "room-project-"));
  const p = { repo: "https://github.com/owner/repo" };
  const nova = await repo(path.join(root, "nova", "repo"), "git@github.com:owner/repo.git");
  const kit = await repo(path.join(root, "kit", "shop"), "https://github.com/Owner/Repo");
  const other = await repo(path.join(root, "kit", "other"), "git@github.com:owner/other.git");
  const vera1 = await repo(path.join(root, "vera", "a"), "https://github.com/owner/repo.git");
  const vera2 = await repo(path.join(root, "vera", "b"), "ssh://git@github.com/owner/repo");
  const own = await repo(path.join(root, "own"), "owner/repo");

  assert.deepEqual(await resolveMember(p, { projects: [nova], own: path.join(root, "nowhere") }, git), { state: "resolved", path: nova });
  assert.deepEqual(await resolveMember(p, { projects: [other, kit] }, git), { state: "resolved", path: kit });
  // A subfolder of the same copy is that one copy, not two.
  assert.deepEqual(await resolveMember(p, { projects: [nova, nova] }, git), { state: "resolved", path: nova });
  const amb = await resolveMember(p, { projects: [vera1, vera2] }, git);
  assert.equal(amb.state, "ambiguous");
  assert.deepEqual(amb.state === "ambiguous" && amb.paths.sort(), [vera1, vera2].sort());
  assert.deepEqual(await resolveMember(p, { projects: [other], own }, git), { state: "resolved", path: own });
  assert.deepEqual(await resolveMember(p, { projects: [other, path.join(root, "missing")] }, git), { state: "unresolved" });
  // Its own folder only when none of its projects is the repo.
  assert.deepEqual(await resolveMember(p, { projects: [kit], own }, git), { state: "resolved", path: kit });
});

test("a copy without the room's branch stays resolved with the branch missing; a remote's copy of it counts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "room-project-"));
  const a = await repo(path.join(root, "a"), "owner/repo", ["main"]);
  const b = await repo(path.join(root, "b"), "owner/repo");
  const c = await repo(path.join(root, "c"), "owner/repo");
  await git(c, ["update-ref", "refs/remotes/origin/release/2", "HEAD"]);
  const p = { repo: "https://github.com/owner/repo", branch: "main" };
  const ra = await resolveMember(p, { projects: [a] }, git);
  const rb = await resolveMember(p, { projects: [b] }, git);
  assert.deepEqual(ra, { state: "resolved", path: a, branch: "present" });
  assert.deepEqual(rb, { state: "resolved", path: b, branch: "missing" });
  assert.equal(ready(ra), true);
  assert.equal(ready(rb), false);
  assert.match(notReadyWhy(rb, p), /not the branch main: fetch it in its copy, without switching/);
  assert.deepEqual(await resolveMember({ ...p, branch: "release/2" }, { projects: [c] }, git), { state: "resolved", path: c, branch: "present" });
});

test("a crew mate's note names its copy, or says it has none rather than working elsewhere", () => {
  const p = { repo: "https://github.com/owner/repo", branch: "main" };
  assert.match(projectNote(p, { state: "resolved", path: "/x/repo", branch: "present" }), /Your copy of it is \/x\/repo/);
  assert.match(projectNote(p, { state: "unresolved" }), /don't do project work in another folder/);
  assert.match(projectNote(p, { state: "resolved", path: "/x/repo", branch: "missing" }), /fetch it there/);
  assert.match(notReadyWhy({ state: "unchecked", why: "its computer is away" }, p), /couldn't be checked/);
});

test("a copy's branches for the picker: its own and its remotes', each once, and the remote's default branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "room-project-"));
  const dir = await repo(path.join(root, "a"), "owner/repo", ["main", "feature/pay"]);
  await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(dir, ["update-ref", "refs/remotes/origin/release/2", "HEAD"]);
  await git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const b = await branchesAt(git, dir);
  assert.equal(b.default, "main");
  assert.deepEqual([...b.branches].sort(), ["feature/pay", "main", "release/2", "trunk"]);
  assert.deepEqual(await branchesAt(git, path.join(root, "nowhere")), { branches: [] });
});

test("a remote's branches and default, as git ls-remote --symref says them", () => {
  const out = "ref: refs/heads/main\tHEAD\n1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\tHEAD\n1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\trefs/heads/main\n2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c\trefs/heads/feature/pay\n";
  assert.deepEqual(parseLsRemote(out), { branches: ["main", "feature/pay"], default: "main" });
  assert.deepEqual(parseLsRemote(""), { branches: [] });
});

test("a repo's remote branches are read for real: ls-remote of a local bare repo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "room-project-"));
  const src = await repo(path.join(root, "src"), "owner/repo", ["main", "feature/x"]);
  const bare = path.join(root, "bare.git");
  await git(root, ["clone", "-q", "--bare", src, bare]);
  const out = await git(root, ["ls-remote", "--symref", bare, "HEAD", "refs/heads/*"]);
  const r = parseLsRemote(out);
  assert.equal(r.default, "trunk");
  assert.deepEqual([...r.branches].sort(), ["feature/x", "main", "trunk"]);
});
