import { test } from "node:test";
import assert from "node:assert/strict";
import { namedBranch, spareBranch } from "../src/client/branch-names.js";
import { byRepo, folderLine, folderName, madeByFriday, ranked } from "../src/client/Workspace.js";

// A row shows only a branch somebody named (audit CODE-15 A); Friday's spares are never offered (audit CODE-16 A).
test("named branches are told from generated ones", () => {
  for (const b of ["dev", "fix/export-timeout", "feature/login", "release/1.2"]) assert.equal(namedBranch(b), true, b);
  for (const b of ["main", "master", "friday/2026-11-04-0519", "2026-11-04-1132", "friday/spare-3", "claude/b37001cc", "codex/fix-it", undefined, ""]) assert.equal(namedBranch(b), false, String(b));
  assert.equal(spareBranch("friday/spare-ab12"), true);
  assert.equal(spareBranch("feature/spare-parts"), false);
});

// The folder picker says a repository once, by a person's name for it, with its branch and where it is from home (CODE-16 A).
test("the folder picker lists a repository once, its worktrees under it", () => {
  const home = "/Users/ada";
  const repo = { path: `${home}/code/edge-app`, name: "edge-app", isRepo: true, branch: "fix/export-timeout", remote: "git@github.com:ada/edge-app.git" };
  // A worktree's .git is a file: it says no branch or origin, and its folder is "<repo>-<id>".
  const wt = { path: `${home}/.friday/worktrees/edge-app-1a2b3c4d`, name: "edge-app-1a2b3c4d", isRepo: true };
  const scratch = { path: `${home}/Library/Application Support/Claude/scratch-workspaces/9e41c2/scratch-2026-11-03-c0317b`, name: "scratch-2026-11-03-c0317b", isRepo: false };
  const rows = byRepo([wt, repo, scratch]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.f.path, repo.path);
  assert.deepEqual(rows[0]!.more.map((x) => x.path), [wt.path]);
  assert.equal(folderLine(repo, false, home), "fix/export-timeout · ~/code");
  // A scratch folder by its app and day (audit CREW-19), never its generated path.
  assert.match(folderLine(scratch, false, home), /^Claude Desktop · \w{3} 3 \w{3}$/);
  // Two clones of the same name with nothing to say they're one repository are two rows, not "worktrees".
  assert.equal(byRepo([repo, { ...repo, path: "/Users/ada/old/edge-app", remote: undefined }]).length, 2);
  assert.equal(folderLine({ path: "C:\\Users\\ada\\code\\api", name: "api", isRepo: true, branch: "main" }, false, "C:\\Users\\ada"), "main · ~\\code");
});

// Arun's e2e pass, 2026-11-04: "New folder" sessions' folders filled Your repos' eight; a scratch folder showed its generated name.
test("Your repos list real repositories before the folders Friday made, and a scratch folder by its human name", () => {
  const home = "/Users/ada";
  const made = (n: string) => ({ path: `${home}/Friday/Projects/${n}`, name: n, isRepo: true, branch: "main" });
  const real = (n: string) => ({ path: `${home}/code/${n}`, name: n, isRepo: true, remote: `git@github.com:ada/${n}.git` });
  const list = [made("look-at-files"), real("edge-app"), made("long-session-note-1"), made("plan-cart"), real("hi-15")];
  assert.deepEqual(ranked(byRepo(list)).map((g) => g.f.name), ["edge-app", "hi-15", "look-at-files", "long-session-note-1", "plan-cart"]);
  assert.deepEqual(ranked(byRepo(list, true), true).map((g) => g.f.name), list.map((f) => f.name), "a plain folder list keeps its order of use");
  assert.equal(madeByFriday(`${home}/Friday/Projects/x`), true);
  assert.equal(madeByFriday("C:\\Users\\ada\\Friday\\Projects\\x"), true);
  assert.equal(madeByFriday(`${home}/Friday/Projects/x/src`), false);
  assert.equal(madeByFriday(`${home}/code/Projects`), false);
  assert.equal(folderName({ name: "scratch-2026-11-03-c0317b", path: `${home}/Library/Application Support/Claude/scratch-workspaces/9e41c2/scratch-2026-11-03-c0317b` }), "Scratch folder");
});
