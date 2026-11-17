import assert from "node:assert/strict";
import test from "node:test";
import { older, versionIn, wayOf } from "../src/runner/tool-updates.js";

// Arun, 2026-11-17: "make sure Friday is able to detect outdated CLI things we are driving these agents from and auto update them".
test("a tool's version, out of what its --version says", () => {
  assert.equal(versionIn("codex-cli 0.166.0"), "0.166.0");
  assert.equal(versionIn("2.1.307 (Claude Code)"), "2.1.307");
  assert.equal(versionIn("1.0.0-beta.3"), "1.0.0-beta.3");
  assert.equal(versionIn("no version here"), null);
});

test("older compares by number, a pre-release before its release", () => {
  assert.ok(older("0.165.0", "0.166.0"));
  assert.ok(older("0.99.9", "0.100.0"));
  assert.ok(!older("0.166.0", "0.166.0"));
  assert.ok(!older("1.2.0", "1.1.9"));
  assert.ok(older("1.2.0-beta.1", "1.2.0"));
});

test("how it was installed, from where its command really lives", () => {
  assert.deepEqual(wayOf("codex", "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js", "darwin"), { kind: "npm", pkg: "@openai/codex", npm: "/opt/homebrew/bin/npm", prefix: "/opt/homebrew" });
  assert.deepEqual(wayOf("gemini", "/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules/@google/gemini-cli/dist/index.js", "darwin"), { kind: "npm", pkg: "@google/gemini-cli", npm: "/Users/a/.nvm/versions/node/v22.1.0/bin/npm", prefix: "/Users/a/.nvm/versions/node/v22.1.0" });
  assert.equal((wayOf("codex", "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "win32") as { pkg: string }).pkg, "@openai/codex");
  assert.deepEqual(wayOf("codex", "/opt/homebrew/Caskroom/codex/0.166.0/codex-aarch64-apple-darwin", "darwin"), { kind: "brew", name: "codex", cask: true, brew: "/opt/homebrew/bin/brew" });
  assert.deepEqual(wayOf("opencode", "/usr/local/Cellar/opencode/1.2.3/bin/opencode", "darwin"), { kind: "brew", name: "opencode", cask: false, brew: "/usr/local/bin/brew" });
  assert.deepEqual(wayOf("claude", "/Users/a/.local/share/claude/versions/2.1.307", "darwin"), { kind: "self", argv: ["update"] });
  assert.deepEqual(wayOf("cursor", "/Users/a/.local/bin/cursor-agent", "darwin"), { kind: "manual" });
});
