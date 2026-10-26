import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { expandCommand, installSkill, skillCommands, skillHomes, toolCommandsIn } from "../src/runner/tool-commands.js";

/**
 * Codex's and Cursor's own `/` commands, when Friday runs them headless: their built-in ones only work in their terminals, so
 * what carries over is what people wrote for them (prompt and command files, skills), expanded as their terminals would.
 */

async function place(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}

test("Codex: its prompts are /prompts:<name>, its skills are $<name>, and a prompt takes its arguments", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-cmds-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const prev = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => (prev === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = prev)));
  await place(home, {
    ".codex/prompts/fix-issue.md": "---\ndescription: Fix a GitHub issue\nargument-hint: <number>\n---\nFix issue #$1 and explain: $ARGUMENTS\n",
    ".codex/skills/hatch-pet/SKILL.md": "---\nname: hatch-pet\ndescription: Make a pet\n---\n# Hatch\n",
  });
  const found = await toolCommandsIn("codex", path.join(home, "repo"), home);
  assert.deepEqual(found.map((c) => [c.name, c.insert, c.description, c.hint]), [
    ["prompts:fix-issue", "/prompts:fix-issue ", "Fix a GitHub issue", "<number>"],
    ["hatch-pet", "$hatch-pet ", "Make a pet", undefined],
  ]);
  assert.equal(await expandCommand("/prompts:fix-issue 42 quickly", found), "Fix issue #42 and explain: 42 quickly");
  assert.equal(await expandCommand("/nope", found), null, "not one of its commands: sent as the words it is");
});

test("Cursor: the project's commands over the person's, its skills, and a command with no placeholder gets the rest after it", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-cmds-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = path.join(home, "repo");
  await place(home, {
    "repo/.cursor/commands/review.md": "Review the diff for bugs.\n",
    ".cursor/commands/review.md": "The person's own review.\n",
    ".cursor/commands/ship.md": "# Ship it\nRun the checks, then open a PR.\n",
    ".cursor/skills-cursor/create-rule/SKILL.md": "---\nname: create-rule\ndescription: Write a Cursor rule\n---\n",
  });
  const found = await toolCommandsIn("cursor", repo, home);
  assert.deepEqual(found.map((c) => [c.name, c.insert]), [["review", "/review "], ["ship", "/ship "], ["create-rule", "/create-rule "]]);
  assert.equal(found.find((c) => c.name === "ship")!.description, "Ship it", "a heading is a description when there is no header");
  assert.equal(await expandCommand("/review src/app.ts", found), "Review the diff for bugs.\n\nsrc/app.ts", "the project's, with what followed it after");
  assert.match((await expandCommand("/create-rule for tests", found))!, /^Use the "create-rule" skill: read .*SKILL\.md and follow it\.\n\nfor tests$/);
});

test("a Friday skill put into the coding tools lands where each reads its skills, and never over one of their own", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-skill-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const saved = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => (saved === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = saved)));
  const skill = { name: "Review a Diff!", description: 'Use to review "a change"', instructions: "Read the diff and the code around it." };

  const first = await installSkill(skill, ["claude", "codex", "cursor"], home);
  assert.deepEqual(first.added.map((a) => [a.tool, a.call]), [["claude", "/review-a-diff"], ["codex", "$review-a-diff"], ["cursor", "/review-a-diff"]]);
  const text = await readFile(path.join(skillHomes(home).claude!, "review-a-diff", "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: review-a-diff\ndescription: "Use to review 'a change'"\n---\n/, "a header the tools read, with nothing that breaks it");
  assert.ok((await toolCommandsIn("codex", home, home)).some((c) => c.insert === "$review-a-diff "), "Codex finds it as a skill");
  assert.ok((await toolCommandsIn("cursor", home, home)).some((c) => c.insert === "/review-a-diff "), "and so does Cursor");
  // Any other tool's menu offers the skills in its own folder before the tool has listed its commands itself.
  assert.deepEqual((await skillCommands("kiro", home)).map((c) => c.insert), [], "none yet for Kiro");
  await installSkill(skill, ["kiro"], home);
  assert.deepEqual((await skillCommands("kiro", home)).map((c) => c.insert), ["/review-a-diff "]);

  // Their own skill of that name is theirs; Friday's own copy is Friday's to update.
  await writeFile(path.join(skillHomes(home).cursor!, "review-a-diff", "SKILL.md"), "---\nname: review-a-diff\n---\nMine.\n");
  const again = await installSkill({ ...skill, instructions: "Read it twice." }, ["claude", "cursor"], home);
  assert.deepEqual(again.added.map((a) => a.tool), ["claude"]);
  assert.equal(again.skipped[0]?.tool, "cursor");
  assert.match(await readFile(path.join(skillHomes(home).claude!, "review-a-diff", "SKILL.md"), "utf8"), /Read it twice/);
  assert.match(await readFile(path.join(skillHomes(home).cursor!, "review-a-diff", "SKILL.md"), "utf8"), /Mine\./);
});
