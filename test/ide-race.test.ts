// Race in Code's column (Arun, 2026-11-19, wave 2: "Race the tools"): who races by default, what a row says, what Compare asks the
// IDE for, and how the extension opens a racer's checkout for Review changes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareDetail, defaultRacers, keptNote, keptShort, raceFacts, raceTime, raceTitle, racerNames, toggleRacer } from "../src/client/ide/race.js";
import { reviewArg } from "../src/runner/vscode.js";

const require = createRequire(import.meta.url);
const race = require("../src/vscode-ext/friday/race.js");

test("racers: the tool in the box first, then what is signed in, three at most", () => {
  assert.deepEqual(defaultRacers(["claude", "codex", "cursor", "gemini"], "codex"), ["codex", "claude", "cursor"]);
  assert.deepEqual(defaultRacers(["claude", "codex"], ""), ["claude", "codex"]);
  assert.deepEqual(defaultRacers(["claude", "codex"], "cursor"), ["claude", "codex"]);
  assert.deepEqual(defaultRacers(["claude"], "claude"), ["claude"]);
  assert.deepEqual(toggleRacer(["claude", "codex"], "codex"), ["claude"]);
  assert.deepEqual(toggleRacer(["claude", "codex"], "cursor"), ["claude", "codex", "cursor"]);
  assert.deepEqual(toggleRacer(["claude", "codex", "cursor"], "gemini"), ["claude", "codex", "cursor"], "never a fourth");
  assert.equal(racerNames(["claude", "codex", "cursor"]), "Claude Code, Codex and Cursor");
});

test("the race's chat is named for the ask, short", () => {
  assert.equal(raceTitle("Add a Notes section\nto the README"), "Race: Add a Notes section");
  assert.equal(raceTitle("   "), "Race: the tools");
  assert.ok(raceTitle("x".repeat(200)).length <= 56);
});

test("a row's facts: changes, tests, time, tokens; nothing claimed while it works", () => {
  assert.deepEqual(raceFacts({ files: 1, added: 3, removed: 0, tests: "pass", seconds: 42, tokens: 3400, working: false }), ["1 file +3 −0", "Tests passed", "42s", "3.4k tokens"]);
  assert.deepEqual(raceFacts({ files: 2, added: 9, removed: 4, tests: "fail", seconds: 185, tokens: null, working: false }), ["2 files +9 −4", "Tests failed", "3m 05s"]);
  assert.deepEqual(raceFacts({ files: 0, added: 0, removed: 0, tests: "none", seconds: 0, tokens: null, working: true }), ["No changes yet"]);
  assert.deepEqual(raceFacts({ files: 0, added: 0, removed: 0, tests: "none", seconds: 5, tokens: null, working: false }), ["No changes", "Tests not run", "5s"]);
  assert.equal(raceTime(59.6), "1m 00s");
});

test("Keep says where the changes landed", () => {
  assert.equal(keptNote("Codex", 1, 0), "Kept Codex. 1 file is in the folder.");
  assert.equal(keptNote("Codex", 3, 0), "Kept Codex. 3 files are in the folder.");
  assert.match(keptNote("Codex", 3, 2), /2 have conflict marks/);
});

test("after Keep, a short note when the log already counts the files", () => {
  assert.equal(keptShort("Amp"), "Kept Amp. The other copies are gone.");
});

test("Compare names the racer's checkout, the folder's branch, and the diff's tab", () => {
  assert.deepEqual(compareDetail("/tmp/friday-race-ab12cd34", "main", "Codex"), { dir: "/tmp/friday-race-ab12cd34", base: "main", label: "Race · Codex" });
  assert.deepEqual(compareDetail("/x", undefined, "Codex"), { dir: "/x", label: "Race · Codex" });
});

test("the runner keeps only one of Friday's own checkouts, a plain branch name and a short label of a review request", () => {
  const mine = path.join(os.tmpdir(), "friday-race-ab12cd34");
  assert.deepEqual(reviewArg({ dir: mine, base: "feature/x", label: "Race · A\nb", extra: 1 }), { dir: mine, base: "feature/x", label: "Race · A b" });
  assert.deepEqual(reviewArg({ dir: mine, base: "--upload-pack=x" }), { dir: mine });
  assert.deepEqual(reviewArg({ dir: mine, base: "a b" }), { dir: mine });
  assert.equal(reviewArg({ base: "main" }), undefined);
  assert.equal(reviewArg("nope"), undefined);
  assert.equal(reviewArg(null), undefined);
  // Any other folder is not ours to open as a repository.
  assert.equal(reviewArg({ dir: path.join(os.homedir(), "Documents") }), undefined);
  assert.equal(reviewArg({ dir: "/tmp/r" }), undefined);
  assert.equal(reviewArg({ dir: "relative/friday-race-ab12cd34" }), undefined);
  assert.equal(reviewArg({ dir: path.join(os.tmpdir(), "friday-race-ab12cd34", "..", "elsewhere") }), undefined, "no way out of it");
});

test("the extension: a relative or missing folder is no racer; the racer's fork point is tried first", () => {
  assert.equal(race.reviewArgOf({ dir: "relative/path" }), null);
  assert.equal(race.reviewArgOf(undefined), null);
  assert.equal(race.reviewArgOf({ dir: "file:///x" }), null);
  const abs = path.resolve("/tmp/friday-race-ab12cd34");
  assert.deepEqual(race.reviewArgOf({ dir: abs, base: "main", label: "Race · A" }), { dir: abs, base: "main", label: "Race · A" });
  assert.deepEqual(race.baseCandidates({ dir: abs, base: "feature" }).slice(0, 2), ["feature", "origin/HEAD"]);
  // The session's own pull request: its branch, and only its base will do.
  assert.deepEqual(race.reviewArgOf({ dir: abs, base: "origin/main", head: "fix/x", strict: true }), { dir: abs, base: "origin/main", label: "", head: "fix/x", strict: true });
  assert.deepEqual(race.baseCandidates({ dir: abs, base: "origin/main", strict: true }), ["origin/main"]);
  assert.deepEqual(race.baseCandidates(undefined), ["origin/HEAD", "origin/main", "origin/master", "main", "master"]);
  assert.equal(race.reviewTitle({ dir: abs, label: "Race · Codex" }, "friday/race-1", 2), "Race · Codex");
  assert.equal(race.reviewTitle(undefined, "main", 1), "main · 1 file");
  assert.equal(race.reviewTitle(undefined, "", 3), "This branch · 3 files");
});

test("the extension opens a racer's repository when git has not met it, else uses the one it knows", async () => {
  const abs = path.resolve("/tmp/friday-race-ab12cd34");
  const opened: string[] = [];
  const vscode = { Uri: { file: (f: string) => ({ fsPath: f }) } };
  const own = { rootUri: { fsPath: path.resolve("/work/app") } };
  const api = {
    repositories: [own],
    openRepository: async (u: { fsPath: string }) => (opened.push(u.fsPath), { rootUri: { fsPath: u.fsPath } }),
  };
  assert.equal(await race.repoFor(vscode, api, undefined), own, "no racer: the folder's own");
  const r = await race.repoFor(vscode, api, { dir: abs });
  assert.equal(r.rootUri.fsPath, abs);
  assert.deepEqual(opened, [abs]);
  api.repositories.push(r);
  assert.equal(await race.repoFor(vscode, api, { dir: abs }), r, "met already: not opened twice");
  assert.deepEqual(opened, [abs]);
  assert.equal(await race.repoFor(vscode, api, { dir: "relative" }), null, "a folder named but unusable: none, never the folder's own");
  assert.equal(await race.repoFor(vscode, { repositories: [] }, { dir: abs }), null, "an older git without openRepository: none");
  assert.equal(await race.repoFor(vscode, { repositories: [], openRepository: async () => { throw new Error("not a repo"); } }, { dir: abs }), null);
});
