import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ADAPTERS, findBin, launcher, runCli } from "../src/runner/adapters.js";
import { describe } from "../src/runner/workspace.js";
import { canonicalUrl, parseRepo } from "../src/runner/repo.js";

/**
 * Starting a CLI that lives on someone's machine.
 *
 * These are the cases that differ by platform, and each one was a real failure:
 * a Windows install is a .exe or an npm .cmd shim rather than an extensionless
 * file, and `spawn` cannot run a .cmd at all. A shell would, but the Claude
 * adapter passes a multi-line system prompt as one argument and cmd.exe cannot
 * carry a newline, so the shim is unwrapped to the script it runs instead.
 */

const WINDOWS = process.platform === "win32";
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "friday-launch-"));
});
after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("a JS entry point is run with this process's own node, on any platform", async () => {
  const js = path.join(dir, "tool.mjs");
  await writeFile(js, "console.log('hi');\n");
  const l = await launcher(js);
  assert.equal(l.command, process.execPath);
  assert.deepEqual(l.prefix, [js]);
});

test("a native executable is started as itself", async () => {
  const exe = path.join(dir, WINDOWS ? "tool.exe" : "tool");
  await writeFile(exe, "");
  await chmod(exe, 0o755);
  const l = await launcher(exe);
  assert.equal(l.command, exe);
  assert.deepEqual(l.prefix, []);
});

test("an npm .cmd shim is unwrapped to the script it runs, never handed to a shell", async (t) => {
  if (!WINDOWS) return t.skip("Windows shims only");
  const shim = path.join(dir, "claude.cmd");
  const target = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  // The shape npm writes, verbatim.
  await writeFile(
    shim,
    ['@ECHO off', 'SETLOCAL', 'SET dp0=%~dp0', 'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )', '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'].join("\r\n"),
  );
  const l = await launcher(shim);
  assert.equal(l.command, process.execPath);
  assert.deepEqual(l.prefix, [target]);
});

test("a short command (a sign-out) runs through a .cmd shim too, instead of failing with spawn EINVAL", async (t) => {
  if (!WINDOWS) return t.skip("Windows shims only");
  const script = path.join(dir, "node_modules", "fake-cli", "cli.js");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, "console.log('ran ' + process.argv.slice(2).join(' '));\n");
  const shim = path.join(dir, "fake-cli.cmd");
  await writeFile(shim, ['@ECHO off', '"%_prog%"  "%dp0%\\node_modules\\fake-cli\\cli.js" %*'].join("\r\n"));
  assert.deepEqual(await runCli(shim, ["logout"]), { code: 0, out: "ran logout" });
});

test("a .cmd that wraps something unreadable says so instead of guessing", async (t) => {
  if (!WINDOWS) return t.skip("Windows shims only");
  const shim = path.join(dir, "mystery.cmd");
  await writeFile(shim, "@echo off\r\nsome-other-launcher.exe %*\r\n");
  await assert.rejects(launcher(shim), /can't start directly/);
});

test("findBin picks up an executable with the platform's extension", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-bin-"));
  const bin = path.join(home, WINDOWS ? "claude.exe" : "claude");
  await writeFile(bin, "");
  await chmod(bin, 0o755);
  process.env.FRIDAY_CLAUDE_BIN = bin;
  try {
    assert.equal(await findBin("claude"), bin);
  } finally {
    delete process.env.FRIDAY_CLAUDE_BIN;
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a remote git escaped or quoted is read back as the URL it is", async () => {
  const repo = path.join(dir, "cloned");
  const gitDir = path.join(repo, ".git");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  // Backslashes escaped, and the whole value quoted because the path has a
  // space in it — both are how git writes a Windows remote.
  await writeFile(
    path.join(gitDir, "config"),
    '[remote "origin"]\n\turl = "file://C:\\\\Users\\\\Arun Dass\\\\code\\\\api.git"\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  );
  const info = await describe(repo);
  assert.equal(info.remote, "file://C:\\Users\\Arun Dass\\code\\api.git");
  // …and that reads as the same repo as the path someone would type.
  assert.equal(canonicalUrl(info.remote!), canonicalUrl("file://C:/Users/Arun Dass/code/api.git/"));
});

test("a Windows path in a file:// URL names the folder, not the whole path", () => {
  assert.equal(parseRepo("file://C:\\Users\\Arun Dass\\code\\api.git")!.name, "api");
  assert.equal(parseRepo("file:///home/ada/code/api.git")!.name, "api");
  assert.equal(parseRepo("https://github.com/ada/api")!.name, "api");
  // Still refuses anything that could be read as a flag.
  assert.equal(parseRepo("--upload-pack=x"), null);
});

test("an expired login reads as something to fix, not a raw API error", () => {
  // The wording differs by CLI version, and an expired token says neither
  // "not logged in" nor "authentication".
  for (const raw of [
    "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    "Invalid API key · Please run /login",
    "Not logged in · Please run /login",
    "authentication_error: invalid bearer token",
  ]) {
    assert.match(ADAPTERS.claude.explain(raw), /claude auth login/, raw);
  }
  // An unrelated failure is passed through as it came.
  assert.equal(ADAPTERS.claude.explain("ENOSPC: no space left on device"), "ENOSPC: no space left on device");
});
