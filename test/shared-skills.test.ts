import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillsNote } from "../src/runner/shared-skills.js";

/** A skill folder with its SKILL.md. */
async function skill(dir: string, folder: string, header: string) {
  await mkdir(path.join(dir, folder), { recursive: true });
  await writeFile(path.join(dir, folder, "SKILL.md"), `---\n${header}\n---\n\nDo the thing.\n`);
}

test("every coding tool is told the skills on this computer it doesn't load itself: Claude Code's, its plugins', the repo's, the shared ones", async () => {
  // Arun, 2026-10-21: "ensure the coding tools are able to use their skills and stuff that is already downloaded too". The skills
  // downloaded for Claude Code were there for Claude Code alone; Codex beside it in the same session never knew of them.
  const home = await mkdtemp(path.join(tmpdir(), "friday-skills-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "friday-skills-repo-"));
  try {
    await skill(path.join(home, ".claude", "skills"), "design-taste", "name: design-taste\ndescription: Art direction for websites.");
    // A description over several lines, as many SKILL.md files write it.
    await skill(path.join(home, ".claude", "skills"), "reverse", "name: reverse-engineer\ndescription: >\n  Reverse engineer native and\n  browser targets.");
    const plugin = path.join(home, ".claude", "plugins", "cache", "mk", "marketing", "2.0.0");
    await skill(path.join(plugin, "skills"), "copywriting", "name: copywriting\ndescription: Write marketing copy.");
    await writeFile(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "marketing@mk": [{ scope: "user", installPath: plugin }] } }));
    await skill(path.join(cwd, ".claude", "skills"), "token-optimizer", "name: token-optimizer\ndescription: Keep context small.");
    await skill(path.join(home, ".agents", "skills"), "shared-one", "name: shared-one\ndescription: For any agent.");
    // Codex's own: never listed back to it, and its name wins over another of the same name elsewhere.
    await skill(path.join(home, ".codex", "skills"), "own", "name: design-taste\ndescription: Codex's own design skill.");
    await skill(path.join(home, ".codex", "skills"), ".system", "name: hidden\ndescription: Built in.");

    const codex = await skillsNote("codex", cwd, home);
    assert.match(codex, /^Skills on this computer that Codex doesn't load by itself/);
    assert.match(codex, /In \.\/\.claude\/skills:\n- token-optimizer: Keep context small\./, "the repository's, first, by its own path");
    assert.match(codex, /In ~\/\.claude\/skills:\n- reverse-engineer \(folder reverse\): Reverse engineer native and browser targets\./, "a folded description in one line, and the folder when it isn't the name");
    assert.match(codex, /In ~\/\.claude\/plugins\/cache\/mk\/marketing\/2\.0\.0\/skills:\n- copywriting: Write marketing copy\./, "a Claude Code plugin's");
    assert.doesNotMatch(codex, /design-taste/, "a name it has a skill of its own by is its own");
    assert.doesNotMatch(codex, /shared-one|hidden/, "Codex reads ~/.agents itself, and a folder starting with a dot is none");

    // Claude Code loads its own folders and its plugins: told only of the rest.
    const claude = await skillsNote("claude", cwd, home);
    assert.match(claude, /- shared-one: For any agent\./);
    assert.doesNotMatch(claude, /Codex's own/, "Codex's design-taste goes by a name Claude Code has a skill of its own by");
    assert.doesNotMatch(claude, /copywriting|token-optimizer|reverse-engineer/);

    // OpenCode reads Claude Code's folders itself, not its plugins.
    const opencode = await skillsNote("opencode", cwd, home);
    assert.match(opencode, /copywriting/);
    assert.doesNotMatch(opencode, /token-optimizer|reverse-engineer|shared-one/);

    // Nothing to add: no note at all.
    const bare = await mkdtemp(path.join(tmpdir(), "friday-skills-bare-"));
    assert.equal(await skillsNote("codex", bare, bare), "");
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
