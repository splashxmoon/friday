import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpoint, diffTrees } from "../src/runner/git.js";
import { readRepo } from "../src/runner/repo-read.js";

/**
 * What a run changed, read tree against tree. An uploaded copy is a `git init` with nothing staged, and diffing it against
 * the working tree through its empty index used to report every file as deleted and added again.
 */

const run = (cwd: string, args: string[]) => new Promise<void>((ok, no) => execFile("git", args, { cwd, windowsHide: true }, (e) => (e ? no(e) : ok())));

test("a folder with nothing staged shows only what changed since the checkpoint", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-diff-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await run(dir, ["init", "-q"]);
  await writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(dir, "b.ts"), "export const b = 2;\n");
  const cp = await checkpoint(dir, "run");
  assert.ok(cp && /^[0-9a-f]{40}$/.test(cp));

  await writeFile(path.join(dir, "a.ts"), "export const a = 10;\n");
  await writeFile(path.join(dir, "c.ts"), "export const c = 3;\n");
  const files = await diffTrees(dir, cp);
  assert.deepEqual(files.map((f) => [f.path, f.status]).sort(), [["a.ts", "modified"], ["c.ts", "added"]]);
  assert.match(files.find((f) => f.path === "a.ts")!.patch, /-export const a = 1;\n\+export const a = 10;/);

  // Through the folder operation the agent's runtime uses, with the checkpoint as the base and read-only access.
  const out = JSON.parse(await readRepo(dir, { op: "diff", ref: cp, mode: "plan" })) as { base: string; files: { path: string }[] };
  assert.equal(out.base, cp);
  assert.deepEqual(out.files.map((f) => f.path).sort(), ["a.ts", "c.ts"]);
  // HEAD in a repository with no commits is no base at all, and says so instead of guessing.
  assert.ok("error" in (JSON.parse(await readRepo(dir, { op: "diff", mode: "plan" })) as object));
});
