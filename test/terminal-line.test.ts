// A lane's conversation carried on in the person's terminal (runner/terminal-line.ts): the line typed, and what it resumes.
import test from "node:test";
import assert from "node:assert/strict";
import { shellLine, terminalArgs } from "../src/runner/terminal-line.js";

test("Claude Code and Codex carry on the lane's own conversation; Claude Code starts one with a chosen id when there is none", () => {
  assert.deepEqual(terminalArgs("claude", "8f3a1c2e-0000-4000-8000-000000000001", () => "x"), { args: ["--resume", "8f3a1c2e-0000-4000-8000-000000000001"], minted: null });
  assert.deepEqual(terminalArgs("codex", "019a2b3c-4d5e", () => "x"), { args: ["resume", "019a2b3c-4d5e"], minted: null });
  assert.deepEqual(terminalArgs("claude", null, () => "new-id"), { args: ["--session-id", "new-id"], minted: "new-id" });
  // Codex makes its own ids: before its first turn here there is nothing to carry on.
  assert.equal(terminalArgs("codex", null, () => "x"), null);
  assert.equal(terminalArgs("cursor", "abc", () => "x"), null);
  assert.equal(terminalArgs(undefined, "abc", () => "x"), null);
  // An id that would be more than one word to a shell is never put on the line: a fresh one is started instead.
  assert.deepEqual(terminalArgs("claude", "abc; rm -rf ~", () => "safe"), { args: ["--session-id", "safe"], minted: "safe" });
});

test("the line runs the same program as the same account, quoted for the shell it is typed into", () => {
  assert.equal(shellLine({}, ["/opt/homebrew/bin/claude", "--resume", "abc-1"], "darwin"), "/opt/homebrew/bin/claude --resume abc-1");
  assert.equal(
    shellLine({ CLAUDE_CONFIG_DIR: "/Users/maya/Library/Application Support/Friday/accounts/claude/work" }, ["/usr/local/bin/claude", "--resume", "abc"], "darwin"),
    "CLAUDE_CONFIG_DIR='/Users/maya/Library/Application Support/Friday/accounts/claude/work' /usr/local/bin/claude --resume abc",
  );
  assert.equal(shellLine({}, ["/tmp/it's here/codex", "resume", "x"], "linux"), `'/tmp/it'\\''s here/codex' resume x`);
  assert.equal(shellLine({ CODEX_HOME: "C:\\Users\\Maya\\codex" }, ["C:\\Program Files\\nodejs\\node.exe", "C:\\codex.js", "resume", "x"], "win32"), `$env:CODEX_HOME='C:\\Users\\Maya\\codex'; & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\codex.js' 'resume' 'x'`);
  // A variable name a shell would read as anything else is left off.
  assert.equal(shellLine({ "A;B": "1", OK: "2" }, ["claude"], "darwin"), "OK=2 claude");
});
