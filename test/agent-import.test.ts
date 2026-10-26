import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Redis } from "ioredis";
import { AgentRegistry } from "../src/agents.js";
import { discoverAgentFiles, frontMatter, MAX_INSTRUCTIONS } from "../src/runner/agent-files.js";

const ada = { id: "u-ada", name: "Ada" };

test("front matter is read, and a file without it is all prompt", () => {
  assert.deepEqual(frontMatter('---\nname: "reviewer"\ndescription: Reads diffs\nmodel: sonnet\n---\nBe strict.\n'), { data: { name: "reviewer", description: "Reads diffs", model: "sonnet" }, body: "Be strict.\n" });
  assert.deepEqual(frontMatter("Just a prompt."), { data: {}, body: "Just a prompt." });
});

test("agents are found where Claude Code, Codex and Cursor keep them, and nothing else is read", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-ai-home-"));
  const proj = await mkdtemp(path.join(tmpdir(), "friday-ai-proj-"));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }), rm(proj, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })]));
  await mkdir(path.join(home, ".claude", "agents"), { recursive: true });
  await writeFile(path.join(home, ".claude", "agents", "code-reviewer.md"), "---\nname: Code reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: sonnet\n---\nReview the diff for bugs.\n");
  await writeFile(path.join(home, ".claude", "agents", "empty.md"), "---\nname: Empty\n---\n");
  await mkdir(path.join(home, ".codex", "prompts"), { recursive: true });
  await writeFile(path.join(home, ".codex", "AGENTS.md"), "Prefer small commits.\n");
  await writeFile(path.join(home, ".codex", "prompts", "fix-flaky.md"), "Run the test until it fails, then explain why.\n");
  await mkdir(path.join(proj, ".cursor", "rules"), { recursive: true });
  await writeFile(path.join(proj, ".cursor", "rules", "ui.mdc"), "---\ndescription: UI rules\nglobs: src/**/*.tsx\n---\nUse tokens, never literals.\n");
  await mkdir(path.join(proj, ".claude", "agents"), { recursive: true });
  await writeFile(path.join(proj, ".claude", "agents", "big.md"), `---\nname: Big\n---\n${"x".repeat(MAX_INSTRUCTIONS + 500)}`);
  // A link out of the folder is not followed.
  await writeFile(path.join(home, "secret.md"), "Do not read me.\n");
  await symlink(path.join(home, "secret.md"), path.join(home, ".claude", "agents", "link.md")).catch(() => {});

  const found = await discoverAgentFiles([proj], home);
  const by = (k: string) => found.find((f) => f.key.endsWith(k))!;
  assert.equal(by("code-reviewer.md").name, "Code reviewer");
  assert.equal(by("code-reviewer.md").description, "Reviews diffs");
  assert.equal(by("code-reviewer.md").instructions, "Review the diff for bugs.");
  assert.ok(!found.some((f) => f.key.endsWith("empty.md")), "a file with no prompt is not an agent");
  assert.ok(!found.some((f) => /secret|link\.md/.test(f.key)), "links are skipped");
  assert.equal(by("fix-flaky.md").source, "codex");
  assert.equal(by("AGENTS.md").name, "Codex instructions");
  assert.match(by("ui.mdc").instructions, /^Applies to: src\/\*\*\/\*\.tsx\n\nUse tokens/);
  assert.equal(by("big.md").instructions.length, MAX_INSTRUCTIONS);
  assert.match(by("big.md").note ?? "", /Cut to fit/);
});

test("importing makes private agents with no reach, and the same file again updates rather than adds", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new AgentRegistry(redis, prefix);
  const item = { source: "claude", key: "claude:user/code-reviewer.md", name: "Code reviewer", description: "Reviews diffs", instructions: "Review the diff." };
  const a = await store.importMany(ada, [item]);
  assert.deepEqual([a.created, a.updated], [1, 0]);
  const made = a.agents[0]!;
  assert.deepEqual(made.sharing, { mode: "private", people: [] });
  assert.deepEqual(made.tools, { webSearch: false, askHuman: true, connections: "none" });
  assert.equal(made.imported?.key, item.key);

  const b = await store.importMany(ada, [{ ...item, instructions: "Review the diff, then the tests." }]);
  assert.deepEqual([b.created, b.updated], [0, 1]);
  const list = await store.listFor(ada.id);
  assert.equal(list.length, 1, "no copy");
  assert.equal(list[0]!.instructions, "Review the diff, then the tests.");
  assert.equal(list[0]!.version, 2);

  const bad = await store.importMany(ada, [{ ...item, key: "../../etc/passwd" }]);
  assert.deepEqual([bad.created, bad.updated], [0, 0], "a key that is not ours is refused");
});

import { parseModelList } from "../src/runner/agent-files.js";

test("the model list `cursor-agent models` prints is read, and prose around it is not mistaken for models", () => {
  const out = "\x1b[1mAvailable models\x1b[0m\n\nauto - Auto\ngpt-5 - GPT-5 (current, default)\nsonnet-4.5-thinking - Sonnet 4.5 Thinking\nclaude-opus[1m] - Opus 1M\nTip: use --model <id> to switch\nauto - Auto\n";
  assert.deepEqual(parseModelList(out), [
    { id: "auto", label: "Auto" },
    { id: "gpt-5", label: "GPT-5", current: true },
    { id: "sonnet-4.5-thinking", label: "Sonnet 4.5 Thinking" },
    { id: "claude-opus[1m]", label: "Opus 1M" },
  ]);
  assert.deepEqual(parseModelList("Something went wrong"), [], "an answer it cannot read is no list");
});
