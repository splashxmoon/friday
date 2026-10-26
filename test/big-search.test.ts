import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readRepo } from "../src/runner/repo-read.js";

/**
 * Searching a big project has to look at all of it. It used to read the first
 * 600 files and stop, so in a large folder the one match that mattered was
 * usually somewhere it never looked.
 */
const fill = async (dir: string, n: number, needleAt: number) => {
  await mkdir(path.join(dir, "src"), { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(path.join(dir, "src", `m${String(i).padStart(4, "0")}.ts`), i === needleAt ? "export const x = 'zebra-needle';\n" : `export const v${i} = ${i};\n`);
};

test("in a plain folder of a thousand files, a match in the last of them is found", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-search-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await fill(dir, 1000, 999);
  const out = await readRepo(dir, { op: "search", query: "ZEBRA-needle", mode: "plan" });
  assert.match(out, /1 matches/);
  assert.match(out, /src\/m0999\.ts:1:/);
});

test("in a git repository the search is git's own, so it covers every file and respects .gitignore", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-search-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await fill(dir, 800, 799);
  await mkdir(path.join(dir, "ignored"), { recursive: true });
  await writeFile(path.join(dir, "ignored", "gen.ts"), "zebra-needle in generated code\n");
  await writeFile(path.join(dir, ".gitignore"), "ignored/\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const out = await readRepo(dir, { op: "search", query: "zebra-needle", mode: "plan" });
  assert.match(out, /src\/m0799\.ts:1:/);
  assert.doesNotMatch(out, /ignored\/gen\.ts/, "what the project ignores is not searched");
  assert.equal((await readRepo(dir, { op: "search", query: "no-such-thing-anywhere", mode: "plan" })), 'No matches for "no-such-thing-anywhere".');
});

test("a search that runs out of time says how far it got, instead of \"no matches\"", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-search-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  await fill(dir, 300, 299);
  // A clock that runs fast once the search starts reading: its eight seconds are gone after a few files, as on a busy machine.
  const real = Date.now.bind(Date);
  let ticks = 0;
  t.mock.method(Date, "now", () => real() + (ticks++ > 40 ? 60_000 : 0));
  const out = await readRepo(dir, { op: "search", query: "zebra-needle", mode: "plan" });
  t.mock.restoreAll();
  assert.match(out, /^No matches for "zebra-needle" in the \d+ of 300 files searched before the time ran out \(8s\); search a narrower path for the rest\.$/);
});
