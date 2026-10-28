import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { usesApiKey } from "../src/runner/api-key.js";

/** Whether a coding tool here runs on a key its owner shares or on a person's own plan (runner/api-key.ts, own-plan.ts). */

test("Claude Code on a key, a cloud provider or a key helper is shareable; signed in to a Claude plan, or unsure, it is its owner's", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "claude-"));
  assert.equal(await usesApiKey("claude", { CLAUDE_CONFIG_DIR: home }), false, "a Claude sign-in: a personal plan");
  assert.equal(await usesApiKey("claude", { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "sk-ant-x" }), true);
  assert.equal(await usesApiKey("claude", { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "  " }), false, "an empty key is no key");
  assert.equal(await usesApiKey("claude", { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_USE_BEDROCK: "1" }), true);
  assert.equal(await usesApiKey("claude", { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_USE_VERTEX: "0" }), false);
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ apiKeyHelper: "~/bin/key.sh" }));
  assert.equal(await usesApiKey("claude", { CLAUDE_CONFIG_DIR: home }), true, "a key helper in its settings");
});

test("Codex on an API key is shareable; on a ChatGPT plan it is its owner's", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-"));
  assert.equal(await usesApiKey("codex", { CODEX_HOME: home }), false, "nothing signed in: its owner's");
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "x" } }));
  assert.equal(await usesApiKey("codex", { CODEX_HOME: home }), false, "a ChatGPT plan");
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null }));
  assert.equal(await usesApiKey("codex", { CODEX_HOME: home }), true);
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: "sk-x" }));
  assert.equal(await usesApiKey("codex", { CODEX_HOME: home }), false, "its own word on how it signs in wins");
});

test("every other tool is taken as its owner's own plan", async () => {
  for (const tool of ["cursor", "copilot", "gemini", undefined] as const) assert.equal(await usesApiKey(tool, { ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "sk" }), false);
});
