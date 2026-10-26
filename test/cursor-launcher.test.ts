import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launcher } from "../src/runner/adapters.js";

/**
 * Cursor's CLI on Windows is cursor-agent.cmd → a PowerShell script → the
 * newest versions/<date>-<hash>/node.exe running index.js. Friday can't start
 * a script wrapper, so it has to go straight to that node.exe — which is also
 * what lets it ask whether Cursor is signed in, and run it at all.
 */
test("the newest installed version of Cursor's CLI is what gets started", { skip: process.platform !== "win32" && "the .cmd wrapper is a Windows thing" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "friday-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  for (const v of ["2026.09.28-64d2043", "2026.10.02-aaaaaaa", "2026.9.30-bbbbbbb"]) {
    await mkdir(path.join(root, "versions", v), { recursive: true });
    await writeFile(path.join(root, "versions", v, "node.exe"), "");
    await writeFile(path.join(root, "versions", v, "index.js"), "");
  }
  await writeFile(path.join(root, "cursor-agent.cmd"), "@echo off\r\npowershell -File cursor-agent.ps1 %*\r\n");
  const how = await launcher(path.join(root, "cursor-agent.cmd"));
  assert.equal(how.command, path.join(root, "versions", "2026.10.02-aaaaaaa", "node.exe"), "October beats the two September builds, whatever their names sort like");
  assert.deepEqual(how.prefix, [path.join(root, "versions", "2026.10.02-aaaaaaa", "index.js")]);
});

test("a wrapper with nothing behind it still says it can't be started, rather than guessing", { skip: process.platform !== "win32" && "Windows only" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "friday-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await writeFile(path.join(root, "thing.cmd"), "@echo off\r\n");
  await assert.rejects(() => launcher(path.join(root, "thing.cmd")), /script wrapper/);
});
