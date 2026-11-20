import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addRule, detectRule, editRule, parseRules, removeRule, rulesNote, setRuleOn } from "../src/repo-rules.js";
import { commitAll, diffSince } from "../src/runner/git.js";
import { mainFolderOf, readRules, repoOf, rulesNoteFor, rulesRoot, writeRules } from "../src/runner/repo-rules.js";

const twin = createRequire(import.meta.url)("../src/vscode-ext/friday/rules.js");
const view = createRequire(import.meta.url)("../src/vscode-ext/friday/rules-view.js");

const FILE = `# Rules for this repo

Some note a person wrote.

- [x] Use pnpm, never npm or yarn  <!-- from: Fix refunds.spec.ts, at: 2026-11-19, tools: all -->
- [ ] Prefer zod over hand-written validation  <!-- from: you, at: 2026-11-12, tools: all -->
- [x] Ask before touching migrations/  <!-- from: you, at: 2026-11-10, tools: claude,codex -->
- [x] A hand-written rule with no comment
`;

test("parses rules, their sources and tools, and keeps going past odd lines", () => {
  const r = parseRules(FILE);
  assert.equal(r.length, 4);
  assert.deepEqual(r[0], { text: "Use pnpm, never npm or yarn", on: true, from: "Fix refunds.spec.ts", at: "2026-11-19", tools: "all" });
  assert.equal(r[1].on, false);
  assert.equal(r[2].tools, "claude,codex");
  assert.deepEqual(r[3], { text: "A hand-written rule with no comment", on: true, from: "", at: "", tools: "all" });
  assert.deepEqual(parseRules(""), []);
});

test("toggle, edit, remove and add change only their line", () => {
  const off = setRuleOn(FILE, 0, false);
  assert.ok(off.includes("- [ ] Use pnpm, never npm or yarn  <!-- from: Fix refunds.spec.ts, at: 2026-11-19, tools: all -->"));
  assert.ok(off.includes("Some note a person wrote."));
  assert.equal(parseRules(off).filter((r) => r.on).length, 2);
  assert.equal(parseRules(editRule(FILE, 1, "Prefer zod")).at(1)?.text, "Prefer zod");
  assert.equal(parseRules(removeRule(FILE, 0)).length, 3);
  const more = addRule(FILE, { text: "No default exports", from: "you", at: "2026-11-19" });
  assert.equal(parseRules(more).at(-1)?.text, "No default exports");
  assert.equal(addRule(more, { text: "no default exports" }), more, "the same rule is not added twice");
  assert.match(addRule("", { text: "Use pnpm" }), /^# Rules for this repo/);
  assert.equal(parseRules(addRule("", { text: "Use <!-- pnpm --> here" }))[0].text, "Use <!- pnpm -> here", "a comment's brackets are kept visible, not deleted");
});

test("keeps CRLF files CRLF", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  const out = setRuleOn(crlf, 1, true);
  assert.ok(!/[^\r]\n/.test(out));
  assert.equal(parseRules(out).length, 4);
});

test("the note holds the rules that are on and for the tool, and is empty without any", () => {
  const all = rulesNote(FILE);
  assert.match(all, /^Rules for this repo/);
  assert.ok(all.includes("- Use pnpm, never npm or yarn") && !all.includes("zod"));
  assert.ok(rulesNote(FILE, "cursor").includes("pnpm") && !rulesNote(FILE, "cursor").includes("migrations"));
  assert.ok(rulesNote(FILE, "claude").includes("migrations"));
  assert.equal(rulesNote("# nothing\n"), "");
  assert.equal(rulesNote("- [ ] off one\n"), "");
});

test("the extension's twin answers the same as the page's parser", () => {
  assert.deepEqual(twin.parseRules(FILE), parseRules(FILE));
  assert.equal(twin.setRuleOn(FILE, 2, false), setRuleOn(FILE, 2, false));
  assert.equal(twin.editRule(FILE, 0, "Use bun"), editRule(FILE, 0, "Use bun"));
  assert.equal(twin.removeRule(FILE, 3), removeRule(FILE, 3));
  const a = { text: "No default exports", from: "Chat", at: "2026-11-19", tools: "claude" };
  assert.equal(twin.addRule(FILE, a), addRule(FILE, a));
  assert.equal(twin.addRule("", a), addRule("", a));
});

test("detects a stated convention, and only that", () => {
  const yes: [string, string][] = [
    ["We use pnpm here, not npm. Please don't create a package-lock.", "Use pnpm here, not npm"],
    ["we use pnpm, not npm", "Use pnpm, not npm"],
    ["Don't use default exports", "Don't use default exports"],
    ["Never commit directly to main", "Never commit directly to main"],
    ["always run pnpm test:unit before you finish", "Always run pnpm test:unit before you finish"],
    ["Fix the bug. Also, from now on we only write tests with vitest.", "Only write tests with vitest"],
    ["Please avoid lodash in this repo", "Avoid lodash in this repo"],
    ["no default exports", "No default exports"],
    ["We don't use default exports", "Don't use default exports"],
  ];
  for (const [m, want] of yes) assert.equal(detectRule(m), want, m);
  const no = ["Fix the refunds test", "Can you never use npm?", "never mind, that works", "don't worry about it", "Use the new API here", "It always works on my machine", "ok", "", "x".repeat(700), "Stop", "don't forget to push",
    "I don't understand why this fails", "I don't know, try again", "I never said that", "I always get this error when I run it", "I only want the button fixed", "I prefer the second option",
    "we don't have time, just ship it", "we never got the refund email working", "we're on main right now", "We are using the wrong import in foo.ts", "Always the same bug.",
    "Don't push yet", "Don't commit this", "Don't change anything else", "Avoid the sidebar for now", "No problem", "no thanks"];
  for (const m of no) assert.equal(detectRule(m), null, m);
});

test("the runner reads and writes a folder's rules at the repo's root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "friday-rules-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  const deep = path.join(root, "src", "deep");
  assert.equal(rulesRoot(deep), root);
  assert.deepEqual((await readRules(deep)).rules, []);
  assert.equal(await rulesNoteFor(deep, "claude"), "");
  const w = await writeRules(deep, { op: "add", text: "Use pnpm, never npm", from: "a chat" });
  assert.equal(w.file, path.join(root, ".friday", "rules.md"));
  assert.match(await readFile(w.file, "utf8"), /- \[x\] Use pnpm, never npm {2}<!-- from: a chat, at: \d{4}-\d\d-\d\d, tools: all -->/);
  assert.match(await rulesNoteFor(deep, "codex"), /Use pnpm, never npm/);
  await writeRules(deep, { op: "toggle", index: 0, on: false });
  assert.equal(await rulesNoteFor(deep, "codex"), "");
  await writeRules(deep, { op: "toggle", index: 0, on: true });
  await writeRules(deep, { op: "removeText", text: "use PNPM, never npm" });
  assert.deepEqual((await readRules(deep)).rules, []);
  await writeFile(path.join(root, ".friday", "rules.md"), FILE);
  assert.equal((await readRules(root)).rules.length, 4);
});

test("the escape: a chat's title or a rule can't pose as another field or end the comment", () => {
  const out = addRule("", { text: "a-->b", from: "x, at: 2020-01-01, tools: codex", at: "2026-11-19" });
  const [r] = parseRules(out);
  assert.equal(r.tools, "all");
  assert.equal(r.at, "2026-11-19");
  assert.equal(r.text, "a->b");
  assert.equal(twin.addRule("", { text: "a-->b", from: "x, at: 2020-01-01, tools: codex", at: "2026-11-19" }), out);
});

test("a switch changes only its box: a hand-written line keeps its comment and its words, and indented items are not rules", () => {
  const hand = "- [x] Use bun  <!-- hand note -->\n  - [x] nested thing\n- [ ] Other   rule\n";
  assert.equal(parseRules(hand).length, 2);
  assert.equal(setRuleOn(hand, 0, false), "- [ ] Use bun  <!-- hand note -->\n  - [x] nested thing\n- [ ] Other   rule\n");
  assert.equal(setRuleOn(hand, 1, true), "- [x] Use bun  <!-- hand note -->\n  - [x] nested thing\n- [x] Other   rule\n");
  assert.equal(twin.setRuleOn(hand, 0, false), setRuleOn(hand, 0, false));
});

test("the day is the person's own, not UTC's", () => {
  const evening = new Date(2026, 10, 19, 23, 30);
  const out = addRule("", { text: "Use pnpm" }).replace(/at: \d{4}-\d\d-\d\d/, "at: X");
  assert.match(out, /at: X/);
  assert.equal(view.when("2026-11-19", evening.getTime()), "today");
  assert.equal(view.when("2026-11-18", evening.getTime()), "yesterday");
});

async function repo(): Promise<string> {
  const r = await realpath(await mkdtemp(path.join(tmpdir(), "friday-rules-repo-")));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: r, stdio: "ignore" });
  g("init", "-q");
  // CI machines have no global identity, and Friday's own Commit runs plain git: the repo carries one.
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  await writeFile(path.join(r, "a.txt"), "hi\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return r;
}

test("a worktree's rules are its repository's: saved from the copy, read from the main folder and the IDE", async () => {
  const main = await repo();
  const copy = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "friday-rules-wt-"))), "copy");
  execFileSync("git", ["worktree", "add", "-q", "-b", "lane", copy], { cwd: main });
  assert.equal(repoOf(copy), main);
  assert.equal(rulesRoot(path.join(copy)), main);
  assert.equal(view.rulesRoot(copy), main, "the IDE finds the same folder");
  await writeRules(copy, { op: "add", text: "Use pnpm, never npm", from: "a lane" });
  assert.match(await readFile(path.join(main, ".friday", "rules.md"), "utf8"), /Use pnpm/);
  assert.match(await rulesNoteFor(main, "codex"), /Use pnpm/);
  assert.match(await rulesNoteFor(copy, "codex"), /Use pnpm/);
  assert.equal(await readFile(path.join(copy, ".friday", "rules.md"), "utf8").catch(() => ""), "", "nothing is left in the copy");
});

test("a .git file with a Windows gitdir resolves to the repository's folder", async () => {
  const main = await repo();
  const fake = await mkdtemp(path.join(tmpdir(), "friday-rules-win-"));
  // The main folder as a Windows path would name it is not here, so only the shape is checked: a relative gitdir resolves.
  await mkdir(path.join(main, ".git", "worktrees", "w"), { recursive: true });
  await writeFile(path.join(fake, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "w")}\n`);
  assert.equal(repoOf(fake), main);
  const rel = await mkdtemp(path.join(tmpdir(), "friday-rules-rel-"));
  await writeFile(path.join(rel, ".git"), `gitdir: ${path.relative(rel, path.join(main, ".git", "worktrees", "w"))}\n`);
  assert.equal(repoOf(rel), main);
  await writeFile(path.join(fake, ".git"), "gitdir: C:\\Users\\a\\proj\\.git\\worktrees\\w\n");
  assert.equal(repoOf(fake), fake, "a main folder that isn't there leaves the folder itself");
});

test("a worktree's main folder is spelled as Windows spells it, though git writes the gitdir with forward slashes", () => {
  const w = path.win32;
  for (const of of [mainFolderOf, view.mainFolderOf as typeof mainFolderOf]) {
    assert.equal(of("C:\\t\\copy", "gitdir: C:/Users/runneradmin/AppData/Local/Temp/rules-repo/.git/worktrees/lane\n", w), "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\rules-repo");
    assert.equal(of("C:\\t\\copy", "gitdir: C:\\repo\\.git\\worktrees\\lane\r\n", w), "C:\\repo");
    assert.equal(of("C:\\t\\copy", "gitdir: ../../repo/.git/worktrees/lane\n", w), "C:\\repo");
    assert.equal(of("/t/copy", "gitdir: /repo/.git/worktrees/lane\n", path.posix), "/repo");
    assert.equal(of("/t/copy", "gitdir: /repo/.git\n", path.posix), "", "a submodule's .git file names no worktree");
  }
});

test("the home folder is never where rules live, and a rule there doesn't reach the repos beneath", async () => {
  const home = path.resolve(homedir());
  assert.equal(rulesRoot(home), null);
  assert.equal(rulesRoot(path.parse(home).root), null);
  await assert.rejects(() => writeRules(home, { op: "add", text: "Home rule" }), /Open one first/);
  assert.equal(await rulesNoteFor(home), "");
  const r = await repo();
  assert.equal(rulesRoot(path.join(r)), r);
});

test("Friday's own Commit carries rules.md and nothing else from .friday/", async () => {
  const r = await repo();
  await writeRules(r, { op: "add", text: "Use pnpm, never npm" });
  await writeFile(path.join(r, ".friday", "environment.json"), "{}");
  const seen = (await diffSince(r, "HEAD")).map((f) => f.path);
  assert.ok(seen.includes(".friday/rules.md"), "the changes list shows the rules file");
  assert.ok(!seen.some((f) => f.includes("environment.json")), "and not Friday's own files");
  await commitAll(r, "Add a rule");
  const tracked = execFileSync("git", ["ls-files"], { cwd: r }).toString();
  assert.match(tracked, /\.friday\/rules\.md/);
  assert.doesNotMatch(tracked, /environment\.json/);
});

test("the runner's rules.write checks what it is given, and keeps one writer at a time", async () => {
  const r = await repo();
  await assert.rejects(() => writeRules(r, undefined as never), /Say what to do/);
  await assert.rejects(() => writeRules(r, { op: "add", text: 5 } as never), /must be text/);
  await assert.rejects(() => writeRules(r, { op: "toggle", index: "x" } as never), /Which rule/);
  await assert.rejects(() => writeRules(r, { op: "nope" } as never), /Say what to do/);
  const long = await writeRules(r, { op: "add", text: "x".repeat(900) });
  assert.equal(long.rules[0].text.length, 300);
  await Promise.all(Array.from({ length: 8 }, (_, i) => writeRules(r, { op: "add", text: `Rule number ${i}` })));
  assert.equal((await readRules(r)).rules.length, 9, "no write lost another");
  assert.equal((await writeRules(r, { op: "removeText", text: "gone entirely" })).removed, false);
  assert.equal((await writeRules(r, { op: "editText", text: "rule number 3", to: "Rule three" })).removed, true);
  assert.ok((await readRules(r)).rules.some((x) => x.text === "Rule three"));
});
