import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { shadowSnapshot, weighFolder, dropShadow } from "../src/runner/git.js";

const make = async (files: Record<string, string>) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-big-"));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
};

/**
 * A big folder should cost a quick "no" rather than minutes of git. The walk
 * stops as soon as it knows, and never goes into what a snapshot would skip.
 */
test("a folder is weighed without walking dependency and build folders", async (t) => {
  const dir = await make({ "src/a.ts": "x", "src/b.ts": "y", "node_modules/pkg/index.js": "z".repeat(5000), "dist/out.js": "w" });
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const w = await weighFolder(dir);
  assert.deepEqual({ files: w.files, bytes: w.bytes, tooBig: w.tooBig }, { files: 2, bytes: 2, tooBig: null });
});

test("it stops by count, by bytes and by the clock, whichever is reached first", async (t) => {
  const dir = await make({ "a.txt": "1234567890", "b.txt": "1234567890", "c.txt": "1234567890" });
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  assert.equal((await weighFolder(dir, { files: 2, bytes: 1e9, ms: 1e9 })).tooBig, "files");
  assert.equal((await weighFolder(dir, { files: 1e9, bytes: 15, ms: 1e9 })).tooBig, "bytes");
  assert.equal((await weighFolder(dir, { files: 1e9, bytes: 1e9, ms: -1 })).tooBig, "time");
});

test("a folder too big to snapshot is skipped with the reason said, and a normal one is snapshotted", async (t) => {
  const dir = await make({ "a.txt": "hello", "b.txt": "world" });
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const said: string[] = [];
  assert.equal(await shadowSnapshot(dir, (m) => said.push(m), { files: 1, bytes: 1e9, ms: 1e9 }), null);
  assert.match(said[0]!, /more than 1 files .* won't be shown as a diff/);

  const ok = await shadowSnapshot(dir);
  assert.ok(ok?.head, "within the limits it is taken as before");
  await dropShadow(ok);
});
