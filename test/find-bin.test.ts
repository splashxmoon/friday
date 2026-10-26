import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findBin, loginStatusCached } from "../src/runner/adapters.js";

/**
 * Looking in every folder on PATH at once is faster, and must not change the
 * answer: the first folder that has the program still wins.
 */
test("the earlier folder on PATH wins when two have the same program, and a missing one is null", async (t) => {
  const a = await mkdtemp(path.join(tmpdir(), "friday-bin-a-"));
  const b = await mkdtemp(path.join(tmpdir(), "friday-bin-b-"));
  const was = { PATH: process.env.PATH, bin: process.env.FRIDAY_CODEX_BIN };
  t.after(async () => {
    process.env.PATH = was.PATH;
    if (was.bin === undefined) delete process.env.FRIDAY_CODEX_BIN;
    else process.env.FRIDAY_CODEX_BIN = was.bin;
    await rm(a, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(b, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const name = process.platform === "win32" ? "codex.cmd" : "codex";
  for (const d of [a, b]) {
    await writeFile(path.join(d, name), "");
    await chmod(path.join(d, name), 0o755);
  }
  delete process.env.FRIDAY_CODEX_BIN;
  process.env.PATH = [a, b, was.PATH].join(path.delimiter);
  const first = await findBin("codex");
  // Another install of codex further along the real PATH must not be what's chosen over ours.
  assert.equal(first, path.join(a, name));
  process.env.PATH = [b, a, was.PATH].join(path.delimiter);
  assert.equal(await findBin("codex"), path.join(b, name));
});

test("a sign-in answer is shared by everyone asking at once, and looked up only once", async () => {
  // A binary that cannot be launched answers null at once, which is enough to see the sharing.
  const asks = await Promise.all([loginStatusCached("claude", "/no/such/claude"), loginStatusCached("claude", "/no/such/claude"), loginStatusCached("claude", "/no/such/claude")]);
  assert.deepEqual(asks, [null, null, null]);
});

test("signed in is answered at once, and looked at again behind that answer once it is ten minutes old", async (t) => {
  const d = await mkdtemp(path.join(tmpdir(), "friday-login-"));
  t.after(() => rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  // A stand-in for `claude auth status --json`, which says what the file says and counts how often it was asked.
  const bin = path.join(d, "claude.mjs");
  const signedIn = path.join(d, "signed-in");
  const looks = path.join(d, "looks");
  await writeFile(signedIn, "true");
  await writeFile(
    bin,
    `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(looks)}, "x");\nprocess.stdout.write(JSON.stringify({ loggedIn: readFileSync(${JSON.stringify(signedIn)}, "utf8") === "true" }));\n`,
  );
  const looked = async () => (await readFile(looks, "utf8").catch(() => "")).length;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const ask = () => loginStatusCached("claude", bin);

  assert.equal(await ask(), true);
  await writeFile(signedIn, "false"); // signed out in a terminal, not through Friday
  assert.equal(await ask(), true, "for ten minutes it isn't looked at again");
  assert.equal(await looked(), 1);

  t.mock.timers.tick(600_001);
  assert.equal(await ask(), true, "then a hand-off still isn't kept waiting on the look");
  for (let i = 0; i < 400 && (await ask()); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(await ask(), false, "and once the look is in, the sign-out shows");
  assert.equal(await looked(), 2, "one look, however often it was asked meanwhile");
});
