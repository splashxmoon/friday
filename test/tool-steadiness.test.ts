// Lessons from T3 Code and Orca (Arun, 2026-11-10: "make ours more stable following their lead"): a sign-in check still running
// is waited on rather than started again beside it, Antigravity is asked less often, and agy never gets a stray Gemini key.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { agyOwnKeys, forgetLoginStatus, loginStatusCached, noteSignInStarted, toolEnv } from "../src/runner/adapters.js";

test("a slow sign-in check still running is waited on, not started a second time beside it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-steady-"));
  const bin = path.join(dir, "agy.mjs");
  const count = path.join(dir, "starts.txt");
  // An `agy models` that takes twelve seconds, as a cold agy can: each start is written down.
  await writeFile(bin, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(count)}, "x");\nsetTimeout(() => { console.log("Gemini 3.8 Flash (gemini-3.8-flash)"); }, 12000);\n`);
  try {
    forgetLoginStatus();
    noteSignInStarted("antigravity"); // quick checks: a sign-in was just started here
    const t0 = Date.now();
    assert.equal(await loginStatusCached("antigravity", bin), null, "past its five seconds: don't know yet");
    assert.ok(Date.now() - t0 < 7_000);
    await new Promise((r) => setTimeout(r, 5_200));
    // Asked again once the answer is stale, with the first agy still at it: it is waited on.
    await loginStatusCached("antigravity", bin);
    assert.equal(await readFile(count, "utf8"), "x", "one agy, not two");
  } finally {
    forgetLoginStatus();
    await rm(dir, { recursive: true, force: true });
  }
});

test("agy goes without an inherited Gemini or Google key, unless its own settings pick a key provider", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-agy-home-"));
  const was = process.env.HOME;
  try {
    process.env.HOME = home;
    const env = { PATH: "/usr/bin", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "k", google_api_key: "lower", GOOGLE_CLOUD_PROJECT: "p" };
    assert.equal(agyOwnKeys(home), false, "no settings: its own Google sign-in");
    assert.deepEqual(toolEnv("antigravity", env), { PATH: "/usr/bin", GOOGLE_CLOUD_PROJECT: "p" });
    assert.deepEqual(toolEnv("gemini", env), env, "Gemini CLI keeps its key");
    await mkdir(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
    const settings = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    await writeFile(settings, JSON.stringify({ theme: "dark" }));
    assert.equal(agyOwnKeys(home), false);
    await writeFile(settings, JSON.stringify({ modelProvider: "gemini-api-key" }));
    assert.equal(agyOwnKeys(home), true);
    assert.deepEqual(toolEnv("antigravity", env), env, "a key provider of its own: its keys stay");
    await writeFile(settings, "{ not json");
    assert.equal(agyOwnKeys(home), true, "unreadable: may name one, so nothing is taken away");
  } finally {
    process.env.HOME = was;
    await rm(home, { recursive: true, force: true });
  }
});
