import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startBackground } from "../src/runner/background.js";
import { endTools } from "../src/runner/owned.js";
import { Terminals } from "../src/runner/terminals.js";

/**
 * What agents leave running (background.ts: a dev server, in a process group of its own) and what runs in a terminal panel's
 * shell (terminals.ts) don't outlive Friday either, as its coding tools no longer do (tool-quit.test.ts). The stand-in ignores
 * SIGINT, SIGTERM and SIGHUP and writes its pid to a file; a process started outside Friday is left alone.
 */
const stubborn = (pidFile: string) =>
  `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => {}); setInterval(() => {}, 1000)'`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number, ms: number) => {
  for (let t = 0; t < ms && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
};
const pidIn = async (file: string) => {
  for (let i = 0; i < 100; i++) {
    const n = Number(await readFile(file, "utf8").catch(() => ""));
    if (n > 0) return n;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no pid in ${file}`);
};

test("on quit, an agent's background command and a terminal's job end, and nothing started elsewhere does", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-owned-"));
  const pids: number[] = [];
  t.after(async () => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });
  // Started by the person, outside Friday.
  const outside = spawn("/bin/sh", ["-c", stubborn(path.join(dir, "outside"))], { stdio: "ignore", detached: true });
  outside.unref();
  // An agent's dev server.
  await startBackground(dir, stubborn(path.join(dir, "bg")), { settleMs: 300 });
  // A job in a terminal panel's shell.
  const terms = new Terminals(() => {});
  process.env.FRIDAY_SHELL = "/bin/sh";
  terms.handle({ op: "start", owner: "o", id: "t1", req: "r1", cwd: dir, cols: 80, rows: 24 } as never);
  await new Promise((r) => setTimeout(r, 1500));
  terms.handle({ op: "write", owner: "o", id: "t1", data: `${stubborn(path.join(dir, "pty"))} &\n` } as never);
  const [bg, pty, other] = await Promise.all([pidIn(path.join(dir, "bg")), pidIn(path.join(dir, "pty")), pidIn(path.join(dir, "outside"))]);
  pids.push(bg, pty, other);
  // Quitting, as the runner and the local Friday do: the terminals closed, then everything given three seconds.
  terms.stopAll();
  await endTools(3000);
  assert.equal(await gone(bg, 2000), true, "the background command kept running");
  assert.equal(await gone(pty, 2000), true, "the terminal's job kept running");
  assert.equal(alive(other), true, "something started outside Friday was ended");
});

test("the same when the process just exits (a runner told to quit, its app gone)", { skip: process.platform === "win32", timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-owned-"));
  let bg = 0;
  t.after(async () => {
    if (bg && alive(bg)) process.kill(bg, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });
  const mod = path.resolve("src/runner/background.ts");
  const runner = `
    const { startBackground } = await import(${JSON.stringify(mod)});
    await startBackground(${JSON.stringify(dir)}, ${JSON.stringify(stubborn(path.join(dir, "bg")))}, { settleMs: 300 });
    setTimeout(() => process.exit(0), 700);
  `;
  const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", runner], { stdio: "inherit" });
  await new Promise((r) => p.once("exit", r));
  bg = await pidIn(path.join(dir, "bg"));
  assert.equal(await gone(bg, 2000), true, "the background command kept running after its runner exited");
});
