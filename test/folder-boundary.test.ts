import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { contains, folderKey } from "../src/folder-key.js";
import { readRepo } from "../src/runner/repo-read.js";

/**
 * The folder a host lends is the whole of what Friday's agent may touch on
 * that machine: not where a link inside it points, not Friday's own state,
 * and not the secrets a project keeps next to its code.
 */

let top = "";
let repo = "";
let outside = "";
const OUT = "That path is outside the folder this agent is working in.";
const edits = { mode: "edits" as const };

before(async () => {
  top = await mkdtemp(path.join(tmpdir(), "friday-bound-"));
  repo = path.join(top, "repo");
  outside = path.join(top, "outside");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, ".friday"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "top secret\n");
  await writeFile(path.join(repo, "src", "app.ts"), "export const x = 1;\n");
  await writeFile(path.join(repo, ".friday", "x"), "friday state\n");
  // "dir" makes a junction on Windows, which needs no special rights; a file link may, so those tests skip without.
  await symlink(outside, path.join(repo, "linked"), "junction");
  await symlink(path.join(outside, "secret.txt"), path.join(repo, "leak.txt")).catch(() => {});
  await writeFile(path.join(repo, ".env"), 'API_KEY=sk-live-123\n# old: sk-old-456\nexport DB_URL="postgres://u:pw@h/db"\nMULTI="line1\nsk-hidden-789"\nPRIV="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiGSecretBody==\n-----END PRIVATE KEY-----"\n');
  await writeFile(path.join(repo, ".env.local"), "LOCAL_TOKEN=tok-abc\n");
  await writeFile(path.join(repo, ".env.example"), "API_KEY=put-yours-here\n");
  // A repository, so search goes through git grep, which sees dotfiles the plain walk skips.
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await writeFile(path.join(repo, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
});
after(() => rm(top, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const fileLink = () => existsSync(path.join(repo, "leak.txt"));

test("a link inside the folder to a file outside it is refused for read, write and edit", async (t) => {
  if (!fileLink()) return t.skip("no file symlinks here");
  assert.equal(await readRepo(repo, { op: "read", path: "leak.txt" }), OUT);
  assert.equal(await readRepo(repo, { op: "write", path: "leak.txt", content: "pwned", ...edits }), OUT);
  assert.equal(await readRepo(repo, { op: "edit", path: "leak.txt", find: "top", content: "pwned", ...edits }), OUT);
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "top secret\n");
});

test("a linked folder is refused, for files in it and new files under it", async () => {
  assert.equal(await readRepo(repo, { op: "read", path: "linked/secret.txt" }), OUT);
  assert.equal(await readRepo(repo, { op: "edit", path: "linked/secret.txt", find: "top", content: "x", ...edits }), OUT);
  assert.equal(await readRepo(repo, { op: "write", path: "linked/new/planted.txt", content: "x", ...edits }), OUT);
  assert.equal(existsSync(path.join(outside, "new")), false);
  assert.equal(await readRepo(repo, { op: "tree", path: "linked" }), OUT);
  assert.equal(await readRepo(repo, { op: "search", path: "linked", query: "secret" }), OUT);
});

test("a link that points at nothing yet can't be written through", async (t) => {
  if (!fileLink()) return t.skip("no file symlinks here");
  await symlink(path.join(outside, "made.txt"), path.join(repo, "dangling.txt"));
  assert.equal(await readRepo(repo, { op: "write", path: "dangling.txt", content: "x", ...edits }), OUT);
  assert.equal(existsSync(path.join(outside, "made.txt")), false);
});

test("Friday's own folder is refused however it is spelled", { skip: process.platform === "linux" && "case-sensitive file system" }, async () => {
  for (const p of [".friday/x", ".FRIDAY/x", ".Friday/x"]) assert.equal(await readRepo(repo, { op: "read", path: p }), OUT, p);
  assert.equal(await readRepo(repo, { op: "write", path: ".FRIDAY/y", content: "x", ...edits }), OUT);
});

test("ordinary paths and brand-new files in new folders still work", async () => {
  assert.equal(await readRepo(repo, { op: "read", path: ".friday/x" }), OUT);
  assert.match(await readRepo(repo, { op: "read", path: "src/app.ts" }), /export const x = 1/);
  assert.match(await readRepo(repo, { op: "write", path: "src/deep/new/file.ts", content: "a\n", ...edits }), /^Created/);
  assert.match(await readRepo(repo, { op: "edit", path: "src/deep/new/file.ts", find: "a", content: "b", ...edits }), /^Edited/);
  assert.equal(await readRepo(repo, { op: "read", path: "../outside/secret.txt" }), OUT);
});

test("a .env shows its variable names, never their values", async () => {
  const out = await readRepo(repo, { op: "read", path: ".env" });
  assert.match(out, /API_KEY=<hidden>/);
  assert.match(out, /DB_URL=<hidden>/);
  assert.match(out, /MULTI=<hidden>/);
  assert.doesNotMatch(out, /sk-|postgres|pw@/);
  assert.doesNotMatch(await readRepo(repo, { op: "read", path: ".env", raw: true }), /sk-/);
  const local = await readRepo(repo, { op: "read", path: ".env.local" });
  assert.match(local, /LOCAL_TOKEN=<hidden>/);
  assert.doesNotMatch(local, /tok-abc/);
  assert.match(await readRepo(repo, { op: "read", path: ".env.example" }), /API_KEY=put-yours-here/);
});

test("key files are refused outright", async () => {
  const words = "That file holds credentials, so Friday's agent doesn't read it.";
  assert.equal(await readRepo(repo, { op: "read", path: "id_rsa" }), words);
  assert.equal(await readRepo(repo, { op: "edit", path: "id_rsa", find: "BEGIN", content: "x", ...edits }), words);
  assert.equal(await readRepo(repo, { op: "write", path: "certs/server.pem", content: "x", ...edits }), words);
});

test("search never returns a .env value, nor a key file", async () => {
  for (const q of ["sk-", "postgres", "tok-abc", "OPENSSH"]) {
    // The first line repeats the query; the matches are below it.
    const found = (await readRepo(repo, { op: "search", query: q })).split("\n").slice(1).join("\n");
    assert.doesNotMatch(found, /sk-live|sk-old|sk-hidden|postgres:|tok-abc|OPENSSH/, q);
  }
  const byName = await readRepo(repo, { op: "search", query: "API_KEY" });
  assert.match(byName, /^\.env:1: API_KEY=<hidden>$/m, "a variable can still be found by its name");
  assert.doesNotMatch(byName, /sk-live/);
  assert.match(byName, /put-yours-here/, "the example file is searched as usual");
  // A line inside a multi-line value that looks like NAME=... is not a variable.
  const inside = await readRepo(repo, { op: "search", query: "MIIE" });
  assert.doesNotMatch(inside, /SecretBody|MIIEvQ/);
  assert.match(await readRepo(repo, { op: "search", query: "PRIV" }), /^\.env:\d+: PRIV=<hidden>$/m);
});

test("search hides .env values and key files in folders with non-ASCII names too", async () => {
  // git quotes such names ("donn\303\251es/.env") unless told not to, which once hid the .env from the filter.
  await mkdir(path.join(repo, "données"), { recursive: true });
  await writeFile(path.join(repo, "données", ".env"), "API_KEY=sk-live-999\n");
  await writeFile(path.join(repo, "données", "id_rsa"), "sk-live-key OPENSSH\n");
  await writeFile(path.join(repo, "données", "notes.md"), "sk-live-doc\n");
  const found = await readRepo(repo, { op: "search", query: "sk-live" });
  assert.doesNotMatch(found, /sk-live-999|sk-live-key|\\303/);
  assert.match(found, /^données\/notes\.md:1: sk-live-doc$/m, "ordinary files there are still found");
  assert.match(await readRepo(repo, { op: "search", query: "API_KEY" }), /^données\/\.env:1: API_KEY=<hidden>$/m);
});

test("a .env can't be edited in place, so edit can't test guesses at a value", async () => {
  const before = await readFile(path.join(repo, ".env"), "utf8");
  for (const [p, find] of [[".env", "API_KEY=sk-live-1"], [".env", "API_KEY=sk-live-X"], [".env.local", "LOCAL_TOKEN=tok"]] as const) {
    assert.match(await readRepo(repo, { op: "edit", path: p, find, content: find, ...edits }), /can't see the values .*Ask a person in the room .*host's machine/, `${p} ${find}`);
  }
  assert.equal(await readFile(path.join(repo, ".env"), "utf8"), before);
  assert.match(await readRepo(repo, { op: "edit", path: ".env.example", find: "put-yours-here", content: "yours", ...edits }), /^Edited/);
});

test("write_file won't overwrite an existing .env, but can create a new one", async () => {
  const env = path.join(repo, ".env");
  const before = await readFile(env);
  for (const p of [".env", "./.env", ".env.local"]) {
    assert.match(await readRepo(repo, { op: "write", path: p, content: "API_KEY=\n", ...edits }), /can't see the values .*Ask a person in the room/, p);
  }
  assert.deepEqual(await readFile(env), before, "byte-identical");
  assert.match(await readRepo(repo, { op: "write", path: "fresh/app/.env", content: "PORT=3000\n", ...edits }), /^Created/);
  assert.equal(await readFile(path.join(repo, "fresh", "app", ".env"), "utf8"), "PORT=3000\n");
  assert.match(await readRepo(repo, { op: "write", path: ".env.example", content: "API_KEY=\n", ...edits }), /^Rewrote/);
});

test("folderKey folds case where the platform does, and contains() is by segment", () => {
  assert.equal(folderKey("/no/such/Place/Here/", "win32"), folderKey("/no/such/Place/Here", "win32"));
  assert.equal(folderKey("/no/such/Place", "darwin"), folderKey("/NO/SUCH/place", "darwin"));
  assert.notEqual(folderKey("/no/such/Place", "linux"), folderKey("/no/such/place", "linux"));
  assert.equal(folderKey("/no/such/Place", "linux").includes("\\"), false);
  assert.equal(contains(repo, path.join(repo, "src", "app.ts")), true);
  assert.equal(contains(repo, repo + path.sep), true);
  assert.equal(contains(repo, repo + "-sibling"), false);
  assert.equal(contains(repo, path.join(repo, "linked", "secret.txt")), false);
});
