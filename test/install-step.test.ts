import assert from "node:assert/strict";
import test from "node:test";
import { installStep, osOf } from "../src/client/engines.js";

test("the install line is the one for the system it will be run on, with the shell named", () => {
  assert.deepEqual(installStep("cursor", "windows"), { shell: "PowerShell", command: "irm 'https://cursor.com/install?win32=true' | iex" });
  assert.deepEqual(installStep("cursor", "mac"), { shell: "Terminal", command: "curl https://cursor.com/install -fsS | bash" });
  assert.equal(installStep("cursor", "linux").command, "curl https://cursor.com/install -fsS | bash");
  assert.equal(installStep("cursor", "linux").shell, "Shell");
});

test("agents that install through npm say what they need, and the line is the same everywhere", () => {
  for (const os of ["windows", "mac", "linux"] as const) {
    assert.equal(installStep("claude", os).command, "npm install -g @anthropic-ai/claude-code");
    assert.equal(installStep("codex", os).command, "npm install -g @openai/codex");
    assert.match(installStep("codex", os).needs!, /Node\.js/);
  }
});

test("the system is read from the desktop app when it says, and from the browser otherwise", () => {
  assert.equal(osOf("win32", ""), "windows");
  assert.equal(osOf("darwin", ""), "mac");
  assert.equal(osOf("linux", ""), "linux");
  assert.equal(osOf(undefined, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(osOf(undefined, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "mac");
  assert.equal(osOf(undefined, "Mozilla/5.0 (X11; Linux x86_64)"), "linux");
});
