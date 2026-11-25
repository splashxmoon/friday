// Lessons from T3 Code and Orca (Arun, 2026-11-10: "make ours more stable following their lead"): a sign-in check still running
// is waited on rather than started again beside it, Antigravity is asked less often, and agy never gets a stray Gemini key.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { forgetLoginStatus, loginStatusCached, noteSignInStarted } from "../src/runner/adapters.js";

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


test("agy is given the Gemini API key in the environment: with it, agy runs on the key, which offers Gemini 4", async () => {
  // Arun, 2026-11-24: "make friday pass the gemini api key to agy". An `agy models` that lists Gemini 4 Neon only when it has the key.
  const dir = await mkdtemp(path.join(tmpdir(), "friday-agy-key-"));
  const bin = path.join(dir, "agy.mjs");
  await writeFile(bin, `console.log(process.env.GEMINI_API_KEY === "g-key" ? "gemini-4-neon-high\\tGemini 4 Neon (High)" : "Please sign in to view available models");\n`);
  const was = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = "g-key";
    forgetLoginStatus();
    assert.equal(await loginStatusCached("antigravity", bin), true, "agy saw the key, so it lists its models");
  } finally {
    if (was === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = was;
    forgetLoginStatus();
    await rm(dir, { recursive: true, force: true });
  }
});
