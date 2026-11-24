// The Skills page's library (runner/skill-library.ts) and its GitHub folders (skill-import.ts readSkillFolders): the person's
// skills in ~/.agents/skills, written, renamed, removed to Friday's trash, copied from a coding tool, and brought from GitHub whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyIn, readLibrary, readSkill, removeAt, removeSkill, repoKey, saveSkill, writeFolders } from "../src/runner/skill-library.js";
import { skillsNote } from "../src/runner/shared-skills.js";
import { readSkillFolders, type Fetcher } from "../src/skill-import.js";

async function home(t: { after: (f: () => Promise<void>) => void }) {
  const h = await mkdtemp(path.join(tmpdir(), "friday-skills-"));
  const was = process.env.FRIDAY_HOME;
  process.env.FRIDAY_HOME = path.join(h, ".friday");
  t.after(async () => {
    if (was === undefined) delete process.env.FRIDAY_HOME;
    else process.env.FRIDAY_HOME = was;
    await rm(h, { recursive: true, force: true });
  });
  return h;
}

const put = async (file: string, text: string) => (await mkdir(path.dirname(file), { recursive: true }), writeFile(file, text));
const exists = (p: string) => stat(p).then(() => true, () => false);

test("a skill written on the page is a SKILL.md in ~/.agents/skills that every tool's note names, and a new name moves its folder", async (t) => {
  const h = await home(t);
  const s = await saveSkill({ name: "Review Pull Request", description: 'Reviewing a PR: our "standards" first', body: "1. Read it.\n2. Run the tests." }, h);
  assert.equal(s.folder, "review-pull-request");
  const file = path.join(h, ".agents", "skills", "review-pull-request", "SKILL.md");
  const text = await readFile(file, "utf8");
  assert.match(text, /^---\nname: review-pull-request\ndescription: "Reviewing a PR: our \\"standards\\" first"\n---\n\n1\. Read it\./);
  assert.deepEqual((await readSkill("review-pull-request", h)).body.trim(), "1. Read it.\n2. Run the tests.");
  // Claude Code doesn't read ~/.agents/skills by itself: its note names it, the person's own first.
  assert.match(await skillsNote("claude", path.join(h, "repo"), h), /In ~\/\.agents\/skills:\n- review-pull-request: Reviewing a PR/);

  // A name another skill has is refused, never written over.
  await assert.rejects(saveSkill({ name: "review pull request", description: "x", body: "y" }, h), /already have a skill called review-pull-request/);
  // Its own header lines stay through an edit; a new name moves the folder with its files.
  await writeFile(file, '---\nname: review-pull-request\ndescription: >\n  old\n  words\nlicense: MIT\nallowed-tools: Read\n---\n\nOld body\n');
  await put(path.join(h, ".agents", "skills", "review-pull-request", "scripts", "check.sh"), "echo ok");
  const moved = await saveSkill({ folder: "review-pull-request", name: "pr-review", description: "New words", body: "New body" }, h);
  assert.equal(moved.folder, "pr-review");
  assert.equal(moved.files, 1);
  assert.equal(await exists(path.join(h, ".agents", "skills", "review-pull-request")), false);
  const after = await readFile(path.join(h, ".agents", "skills", "pr-review", "SKILL.md"), "utf8");
  assert.equal(after, '---\nname: pr-review\ndescription: "New words"\nlicense: MIT\nallowed-tools: Read\n---\n\nNew body\n');
  await assert.rejects(saveSkill({ name: "x", description: "", body: "y" }, h), /when an agent should use it/);
  await assert.rejects(readSkill("../../etc", h), /isn't one of your skills/);

  // Removed: out of the folder, into Friday's trash, whole.
  const gone = await removeSkill("pr-review", h);
  assert.ok(gone.trashed.startsWith(path.join(h, ".friday", "trash", "skills", "pr-review-")));
  assert.equal(await exists(path.join(gone.trashed, "scripts", "check.sh")), true);
  assert.deepEqual((await readLibrary(h)).mine, []);
});

test("each coding tool's skills are listed to copy from, Claude Code's plugins on one shelf, and a copy brings the whole folder", async (t) => {
  const h = await home(t);
  await put(path.join(h, ".claude", "skills", "anatomy", "SKILL.md"), "---\nname: anatomy\ndescription: Isometric figures\n---\nDraw.");
  await put(path.join(h, ".claude", "skills", "anatomy", "scripts", "check.mjs"), "1");
  await put(path.join(h, ".claude", "skills", "anatomy", ".git", "HEAD"), "ref");
  await put(path.join(h, ".codex", "skills", "impeccable", "SKILL.md"), "---\nname: impeccable\ndescription: Design\n---\nBody");
  const plugin = path.join(h, ".claude", "plugins", "cache", "p", "1.0");
  await put(path.join(plugin, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\nBody");
  await put(path.join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { p: [{ installPath: plugin }] } }));
  const was = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => void (was === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = was)));

  const lib = await readLibrary(h);
  assert.deepEqual(lib.shelves.map((s) => [s.id, s.label, s.skills.map((x) => x.name)]), [
    ["claude", "Claude Code", ["anatomy"]],
    ["codex", "Codex", ["impeccable"]],
    ["claude-plugins", "Claude Code plugins", ["deploy"]],
  ]);
  assert.equal(lib.shelves[0]!.skills[0]!.files, 1, "its script, not the .git folder");

  const copied = await copyIn(path.join(h, ".claude", "skills", "anatomy"), h);
  assert.equal(copied.folder, "anatomy");
  assert.equal(await exists(path.join(h, ".agents", "skills", "anatomy", "scripts", "check.mjs")), true);
  assert.equal(await exists(path.join(h, ".agents", "skills", "anatomy", ".git")), false);
  assert.equal(await exists(path.join(h, ".claude", "skills", "anatomy", "SKILL.md")), true, "the tool keeps its own");
  await assert.rejects(copyIn(path.join(h, ".claude", "skills", "anatomy"), h), /already have a skill called anatomy/);
  // Only from a folder the page listed.
  await put(path.join(h, "elsewhere", "x", "SKILL.md"), "---\nname: x\n---\nBody");
  await assert.rejects(copyIn(path.join(h, "elsewhere", "x"), h), /isn't in one of your coding tools' folders/);
});

test("a tool's own skill can be deleted to Friday's trash; one from a plugin can't (Arun, 2026-11-20: \"also allow for deleting of skills too\")", async (t) => {
  const h = await home(t);
  await put(path.join(h, ".claude", "skills", "anatomy", "SKILL.md"), "---\nname: anatomy\ndescription: Isometric figures\n---\nDraw.");
  const plugin = path.join(h, ".claude", "plugins", "cache", "p", "1.0");
  await put(path.join(plugin, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\nBody");
  await put(path.join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { p: [{ installPath: plugin }] } }));
  const r = await removeAt(path.join(h, ".claude", "skills", "anatomy"), h);
  assert.equal(await exists(path.join(h, ".claude", "skills", "anatomy")), false, "gone from the tool's folder");
  assert.equal(await exists(path.join(r.trashed, "SKILL.md")), true, "into the trash, whole");
  assert.ok(r.trashed.startsWith(path.join(h, ".friday", "trash", "skills")));
  await assert.rejects(removeAt(path.join(plugin, "skills", "deploy"), h), /comes with its tool or a plugin/);
  await assert.rejects(removeAt(path.join(h, "elsewhere"), h), /isn't in one of your coding tools' folders/);
  await assert.rejects(removeAt("relative/path", h), /Which skill/);
});

test("two clones of one repository are one project: its origin read from git's own config, however it was written", async (t) => {
  const h = await home(t);
  const clone = async (dir: string, url?: string) => (await mkdir(path.join(h, dir, ".git"), { recursive: true }), url && (await writeFile(path.join(h, dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)));
  await clone("Desktop/edge/edge", "git@github.com:Acme/edge.git");
  await clone("Friday/edge", "https://github.com/acme/edge");
  await clone("other/edge", "https://github.com/someone/edge.git");
  await clone("local/edge");
  const keys = await Promise.all(["Desktop/edge/edge", "Friday/edge", "other/edge", "local/edge"].map((d) => repoKey(path.join(h, d))));
  assert.equal(keys[0], "github.com/acme/edge");
  assert.equal(keys[0], keys[1], "ssh and https, any case: the same repository");
  assert.notEqual(keys[0], keys[2], "another owner's is another repository");
  assert.equal(keys[3], path.resolve(h, "local/edge"), "no origin: the folder itself");
});

/** A repository held in memory, as skill-import.test.ts fakes GitHub. */
function fakeGithub(files: Record<string, string>): Fetcher {
  return async (url) => {
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => String(body), json: async () => body, headers: { get: () => null } });
    if (url.startsWith("https://api.github.com/")) return reply(200, { tree: Object.entries(files).map(([p, text]) => ({ path: p, type: "blob", size: text.length })), truncated: false });
    if (url.startsWith("https://codeload.github.com/")) return reply(404, "");
    const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
    const p = m ? m[1]!.split("/").map(decodeURIComponent).join("/") : "";
    return p in files ? reply(200, files[p]) : reply(404, "");
  };
}

test("a skill from GitHub comes in whole: its SKILL.md as written, its scripts and references at their paths, a nested skill apart", async (t) => {
  const h = await home(t);
  const gh = fakeGithub({
    "skills/tdd/SKILL.md": "---\nname: tdd\ndescription: Test first\nlicense: MIT\n---\nRed, green, refactor.",
    "skills/tdd/scripts/run.py": "print(1)",
    "skills/tdd/references/patterns.md": "notes",
    "skills/tdd/logo.png": "\u0089PNG",
    "skills/tdd/inner/SKILL.md": "---\nname: inner\n---\nAnother.",
    "skills/tdd/inner/notes.md": "inner's own",
  });
  const r = await readSkillFolders(gh, "acme/skills", ["skills/tdd/SKILL.md"]);
  assert.equal(r.repo, "acme/skills");
  const f = r.folders[0]!;
  assert.equal(f.folder, "tdd");
  assert.match(f.skill, /^---\nname: tdd\ndescription: Test first\nlicense: MIT/);
  assert.deepEqual(f.files.map((x) => x.path).sort(), ["references/patterns.md", "scripts/run.py"]);
  assert.equal(f.leftBehind, 1, "the picture; the inner skill's files are its own");

  const w = await writeFolders([...r.folders, { folder: "bad", skill: "---\nname: bad\n---\nx", files: [{ path: "../../escape.txt", text: "no" }, { path: "/abs.txt", text: "no" }, { path: "ok/fine.md", text: "yes" }] }], h);
  assert.deepEqual(w.added.map((a) => a.folder), ["tdd", "bad"]);
  const lib = path.join(h, ".agents", "skills");
  assert.equal(await readFile(path.join(lib, "tdd", "scripts", "run.py"), "utf8"), "print(1)");
  // Sorted here: Windows lists a folder without regard to case ("ok" before "SKILL.md"), macOS and Linux by code point.
  assert.deepEqual((await readdir(path.join(lib, "bad"))).sort(), ["SKILL.md", "ok"], "nothing written outside the skill's folder");
  assert.equal(await exists(path.join(h, "escape.txt")), false);
  // Brought again: the one already there is left as it is.
  const again = await writeFolders(r.folders, h);
  assert.deepEqual(again.skipped.map((s) => s.folder), ["tdd"]);
  await assert.rejects(readSkillFolders(gh, "acme/skills", []), /Choose at least one/);
});

test("a skill Friday writes in the shared folder is Friday's, on a shelf of its own, not among the person's", async (t) => {
  const h = await home(t);
  const { BackdropStore } = await import("../src/backdrops.js");
  const store = new BackdropStore({ root: path.join(h, ".friday", "backdrops"), trash: path.join(h, ".friday", "trash", "backdrops"), skills: path.join(h, ".agents", "skills") });
  await store.start();
  store.close();
  await saveSkill({ name: "Ship it", description: "Releasing", body: "1. Tag." }, h);
  const lib = await readLibrary(h);
  assert.deepEqual(lib.mine.map((s) => s.folder), ["ship-it"], "only what the person wrote");
  const ours = lib.shelves.find((s) => s.kind === "friday");
  assert.equal(ours?.label, "Friday");
  assert.deepEqual(ours?.skills.map((s) => [s.folder, s.friday]), [["friday-backdrop", true]]);
  assert.equal(lib.shelves.at(-1), ours, "last, after the tools' and projects'");
  // Once the person takes the line out to keep their own changes, it's theirs.
  const file = path.join(h, ".agents", "skills", "friday-backdrop", "SKILL.md");
  await writeFile(file, (await readFile(file, "utf8")).replace(/<!-- Friday writes this file\.[^\n]*-->\n?/, ""));
  const after = await readLibrary(h);
  assert.deepEqual(after.mine.map((s) => s.folder).sort(), ["friday-backdrop", "ship-it"]);
  assert.equal(after.shelves.find((s) => s.kind === "friday"), undefined);
});
