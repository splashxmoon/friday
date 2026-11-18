import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { matchTree, needleOf, parsePs, stopCommand } from "../src/runner/stop-command.js";

// Stopping one command an agent runs, from the Tasks tab (Arun, 2026-11-18: "be able to stop any task").

test("a command is found by its words under the tool's process: the shell running it and all it started, nothing else", () => {
  const ps = parsePs(
    [
      "  100     1 claude --print",
      "  200   100 /bin/zsh -c source /tmp/snap.sh && eval 'npm run desktop:build -- --bundles app' < /dev/null && pwd -P >| /tmp/cwd",
      "  201   200 node /repo/node_modules/.bin/electron-builder",
      "  202   201 /usr/bin/codesign --sign x",
      "  300   100 /bin/zsh -c source /tmp/snap.sh && eval 'npm test' < /dev/null",
      "  400     1 /bin/zsh -c eval 'npm run desktop:build -- --bundles app'",
    ].join("\n"),
  );
  assert.deepEqual(matchTree(ps, 100, "cd /repo && npm run desktop:build -- --bundles app").sort(), [200, 201, 202], "its shell and everything under it");
  assert.deepEqual(matchTree(ps, 100, "npm test"), [300]);
  assert.deepEqual(matchTree(ps, 100, "npm run lint"), [], "nothing that isn't running");
  assert.deepEqual(matchTree(ps, 999, "npm test"), [], "only under the tool named");
  // A command's quotes come back re-quoted by the shell's eval: matched all the same.
  const quoted = parsePs(`  10 1 tool\n  11 10 /bin/zsh -c eval 'git commit -m '\\''fix: cart'\\'''`);
  assert.deepEqual(matchTree(quoted, 10, `git commit -m 'fix: cart'`), [11]);
  assert.equal(needleOf("cd 'my repo' && npm test"), "npm test");
});

test("a running command under a stand-in tool is stopped, and the tool goes on", { skip: process.platform === "win32" }, async () => {
  // The "tool": a node process that runs a shell command and stays up after it ends.
  const tool = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn("/bin/sh", ["-c", "sleep 37 && echo done"], { stdio: "ignore" }); c.on("exit", (code, sig) => console.log("exit " + sig)); setTimeout(() => {}, 60000);`], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  tool.stdout!.on("data", (d) => (out += String(d)));
  try {
    await new Promise((r) => setTimeout(r, 500));
    const n = await stopCommand(tool.pid, "sleep 37 && echo done");
    assert.ok(n >= 1, "stopped something");
    for (let i = 0; i < 40 && !out.includes("exit"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /exit SIGTERM/, "the command ended on the polite stop");
    assert.equal(tool.exitCode, null, "the tool itself is still running");
    assert.equal(await stopCommand(tool.pid, "sleep 37 && echo done"), 0, "nothing left to stop");
  } finally {
    tool.kill("SIGKILL");
  }
});
