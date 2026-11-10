// splashxmoon/friday#21: Antigravity's sign-in on Windows said "Opening the sign-in…" for good. A sign-in in a terminal window now
// waits on its own tool, as a sign-in page does, and Windows opens that window with the command as written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsTerminalArgs } from "../src/runner/terminal.js";
import { signInFinished } from "../src/client/MachineBadge.js";

test("Windows: the command goes to cmd as written, quoted so a path with a space survives /c and cmd /k", () => {
  const cmd = `set "CODEX_HOME=C:\\Users\\Ana Li\\.friday\\accounts\\work" && "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ana Li\\AppData\\Roaming\\npm\\agy.js"`;
  const args = windowsTerminalArgs(cmd);
  assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
  // /s drops the outer pair; `cmd /k` drops the pair round the command: what is left is the command, untouched.
  const afterC = args[3]!.slice(1, -1);
  assert.equal(afterC, `start "" cmd /k "${cmd}"`);
  assert.equal(afterC.slice(afterC.indexOf("/k ") + 4, -1), cmd);
});

test("a sign-in in a terminal is over when its own tool is signed in, whatever else still needs one", () => {
  // Claude Code and Copilot still signed out (as in the report): Antigravity signing in is enough.
  assert.equal(signInFinished({ needsSignIn: true, waiting: true, sawSignedOut: true, pending: true }), true);
  // Not before it was seen signed out: a look that hasn't caught up yet isn't "finished".
  assert.equal(signInFinished({ needsSignIn: true, waiting: true, sawSignedOut: false, pending: true }), false);
  assert.equal(signInFinished({ needsSignIn: true, waiting: true, sawSignedOut: true, pending: false }), false);
  // Nothing left to sign in to at all.
  assert.equal(signInFinished({ needsSignIn: false, waiting: false, sawSignedOut: false, pending: undefined }), true);
});

test("a sign-in run in Friday's own terminal is typed as its shell reads it: zsh or bash, PowerShell, cmd", async () => {
  const { shellLine } = await import("../src/runner/terminal.js");
  assert.equal(shellLine(["/opt/homebrew/bin/kilo", "auth", "login"], {}, "darwin", ""), "/opt/homebrew/bin/kilo auth login");
  assert.equal(shellLine(["/Users/a b/bin/codex", "login"], { CODEX_HOME: "/Users/a b/.codex-2" }, "linux", ""), "env 'CODEX_HOME=/Users/a b/.codex-2' '/Users/a b/bin/codex' login");
  assert.equal(shellLine(["/x/it's"], {}, "darwin", ""), `'/x/it'\\''s'`);
  // PowerShell, Windows' shell in Friday's terminal: a quoted path is run with &, a quote doubled, a variable set first.
  assert.equal(
    shellLine(["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\o'neil\\kilo.js", "auth", "login"], { CODEX_HOME: "C:\\Users\\o'neil\\.codex" }, "win32", ""),
    "$env:CODEX_HOME='C:\\Users\\o''neil\\.codex'; & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\o''neil\\kilo.js' 'auth' 'login'",
  );
  assert.equal(shellLine(["C:\\a b\\agent.exe", "login"], { X: "1" }, "win32", "C:\\Windows\\System32\\cmd.exe"), 'set "X=1" && "C:\\a b\\agent.exe" login');
  // Git Bash named in FRIDAY_SHELL on Windows reads it as a Mac's shell does.
  assert.equal(shellLine(["C:/tools/agent.exe", "login"], {}, "win32", "C:\\Program Files\\Git\\bin\\bash.exe"), "C:/tools/agent.exe login");
});

test("a sign-in typed into Friday's own terminal ends its shell with it, so its end says the sign-in's command is over", async () => {
  const { shellLine } = await import("../src/runner/terminal.js");
  assert.equal(shellLine(["/opt/homebrew/bin/kilo", "auth", "login"], {}, "darwin", "", true), "/opt/homebrew/bin/kilo auth login; exit");
  assert.equal(shellLine(["C:\\x\\agent.exe", "login"], {}, "win32", "", true), "& 'C:\\x\\agent.exe' 'login'; exit $LASTEXITCODE");
  assert.equal(shellLine(["agent.exe", "login"], {}, "win32", "cmd.exe", true), "agent.exe login & exit");
});
