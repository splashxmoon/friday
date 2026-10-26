import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launcher } from "../src/runner/adapters.js";

/**
 * A console window flashing up every time the app checked who was signed in.
 *
 * Inside the desktop app the program that runs a CLI's script is the app
 * itself, which has no console; Codex's script starts the real codex.exe, which
 * is then given a console of its own — visible — because there is nothing to
 * share. Running the script with a real node, started hidden, keeps the whole
 * chain on one hidden console.
 */
test("inside the desktop app a script is run with the machine's own node, not with the app", async (t) => {
  const bin = await mkdtemp(path.join(tmpdir(), "friday-node-"));
  const was = { PATH: process.env.PATH, electron: Object.getOwnPropertyDescriptor(process.versions, "electron") };
  t.after(async () => {
    process.env.PATH = was.PATH;
    if (was.electron) Object.defineProperty(process.versions, "electron", was.electron);
    else delete (process.versions as Record<string, unknown>).electron;
    await rm(bin, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  await writeFile(path.join(bin, nodeName), "");
  await chmod(path.join(bin, nodeName), 0o755);
  process.env.PATH = [bin, was.PATH].join(path.delimiter);
  Object.defineProperty(process.versions, "electron", { value: "44.0.0", configurable: true });

  const script = path.join(bin, "codex.js");
  await writeFile(script, "");
  const direct = await launcher(script);
  assert.equal(direct.command, path.join(bin, nodeName));
  assert.deepEqual(direct.prefix, [script]);

  if (process.platform === "win32") {
    // npm's shim for a global package: a .cmd that names the script relative to itself.
    const bs = String.fromCharCode(92);
    await mkdir(path.join(bin, "node_modules", "x", "bin"), { recursive: true });
    await writeFile(path.join(bin, "node_modules", "x", "bin", "x.js"), "");
    await writeFile(path.join(bin, "x.cmd"), `@ECHO off${bs}r${bs}n"%dp0%${bs}node_modules${bs}x${bs}bin${bs}x.js" %*${bs}r${bs}n`.split(bs + "r" + bs + "n").join(String.fromCharCode(13, 10)));
    const shim = await launcher(path.join(bin, "x.cmd"));
    assert.equal(shim.command, path.join(bin, nodeName), "an npm shim goes the same way");
    assert.deepEqual(shim.prefix, [path.join(bin, "node_modules", "x", "bin", "x.js")]);
  }
});
