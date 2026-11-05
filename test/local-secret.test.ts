import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startLocal } from "../src/local/start.js";

/**
 * The key the local Friday signs its links with (start.ts, `<home>/secret`). A file cut short (the computer went off as it was
 * first written) was read as it was, and an empty key signed everything from then on.
 */
for (const [what, kept] of [
  ["an empty", ""],
  ["a blank", "\n  \n"],
] as const) {
  test(`${what} secret file is replaced with a new key as Friday starts`, async (t) => {
    const home = await mkdtemp(path.join(tmpdir(), "friday-secret-"));
    await writeFile(path.join(home, "secret"), kept);
    const friday = await startLocal({ home, port: 0 });
    t.after(async () => {
      await friday.close();
      await rm(home, { recursive: true, force: true });
    });
    const now = (await readFile(path.join(home, "secret"), "utf8")).trim();
    assert.ok(now.length >= 32, `secret is ${JSON.stringify(now)}`);
  });
}

test("a good secret is kept as it is", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-secret-"));
  const key = "k".repeat(43);
  await writeFile(path.join(home, "secret"), `${key}\n`);
  const friday = await startLocal({ home, port: 0 });
  t.after(async () => {
    await friday.close();
    await rm(home, { recursive: true, force: true });
  });
  assert.equal((await readFile(path.join(home, "secret"), "utf8")).trim(), key);
});
