import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { endTools, spawnCli } from "../src/runner/spawn-cli.js";

/**
 * A coding tool outliving Friday. Stopping a runner sends its tool Ctrl-C, then SIGTERM at 4 s and SIGKILL at 8 s, but the runner
 * exits half a second after it is told to quit (cli.ts), the open-source app five seconds at most (src/local/desktop.ts), and the
 * later signals went with them. A tool that didn't take the Ctrl-C (here, one that ignores SIGINT and SIGTERM) kept running.
 */
const stubborn = ["-e", 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number, ms: number) => {
  for (let t = 0; t < ms && alive(pid); t += 50) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

test("a tool that ignores Ctrl-C doesn't outlive the process that started it", { timeout: 30_000 }, async (t) => {
  // A file URL: on Windows a plain D:\... path is read as a URL with the scheme "d:" and the import fails (2026-11-04 public CI).
  const mod = pathToFileURL(path.resolve("src/runner/spawn-cli.ts")).href;
  // Stands in for the runner: starts a tool, tells it to stop as a runner does (Ctrl-C), and exits soon after.
  const runner = `
    const { spawnCli } = await import(${JSON.stringify(mod)});
    const tool = spawnCli(process.execPath, ${JSON.stringify(stubborn)});
    setTimeout(() => { console.log(tool.pid); tool.kill("SIGINT"); setTimeout(() => process.exit(0), 500); }, 500);
  `;
  const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", runner], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  await new Promise((r) => p.once("exit", r));
  const pid = Number(out.trim());
  assert.ok(pid > 0, `no pid: ${out}`);
  t.after(() => void (alive(pid) && process.kill(pid, "SIGKILL")));
  assert.equal(await gone(pid, 2000), true, "the tool kept running after its runner exited");
});

test("ending the tools on quit stops one that ignores Ctrl-C and SIGTERM, within the time given", { timeout: 30_000 }, async (t) => {
  const tool = spawnCli(process.execPath, stubborn);
  const pid = tool.pid!;
  t.after(() => void (alive(pid) && process.kill(pid, "SIGKILL")));
  await new Promise((r) => setTimeout(r, 300));
  tool.kill("SIGINT");
  const at = Date.now();
  await endTools(1000);
  assert.ok(Date.now() - at < 2500, "took too long");
  assert.equal(await gone(pid, 1000), true);
});

test("ending the tools with none running is immediate", async () => {
  const at = Date.now();
  await endTools(5000);
  assert.ok(Date.now() - at < 200);
});
