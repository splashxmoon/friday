import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { projectFolder, projectName } from "../src/runner/local-api.js";

/**
 * A session started with no folder gets a project folder of its own, the way Claude Code makes one: named from what was
 * asked, a git repository from the start, and never somebody's other project.
 */

test("the folder is named from what was asked, not from how it was asked", () => {
  assert.equal(projectName("help build me a nueral network from scratch something very simple"), "nueral-network-scratch");
  assert.equal(projectName("Make a todo app with React and a dark mode"), "todo-react-dark-mode");
  assert.equal(projectName("Snake game!"), "snake-game");
  // Nothing that names anything: still a folder.
  assert.equal(projectName("can you help me?"), "project");
  assert.equal(projectName("🙂 ✨"), "project");
  // A long word is cut, and the name stays short enough to read in a path.
  assert.ok(projectName("supercalifragilisticexpialidocious ".repeat(5)).length <= 40);
});

test("a title in another language names its folder in its own words, never cut mid-character", () => {
  assert.equal(projectName("Café menu for spring"), "café-menu-spring");
  assert.equal(projectName("東京 旅行"), "東京-旅行");
  assert.notEqual(projectName("Привет мир"), "project");
  const long = projectName("𝒜".repeat(60));
  assert.equal(Array.from(long).length, 40);
  assert.ok(!/[\uD800-\uDBFF]$/.test(long), "no half of a character at the end");
});

test("it is a new git repository, and a name already taken is never reused", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "friday-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await projectFolder("a snake game", { name: "Ada" }, root);
  assert.equal(path.basename(first), "snake-game");
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: first, encoding: "utf8" }).trim(), "main", "a repository from the start, so later agents each get a copy");

  // Somebody's work in it already: the next session with the same ask gets a folder of its own.
  await writeFile(path.join(first, "game.js"), "// mine\n");
  const second = await projectFolder("snake game", { name: "Ada" }, root);
  assert.equal(path.basename(second), "snake-game-2");
  assert.deepEqual((await readdir(first)).sort(), [".git", "game.js"], "the first one is left as it was");
});
