import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { childEnv, isClaudeAppBundled } from "../src/runner/adapters.js";
import { parseRepo } from "../src/runner/repo.js";
import { browse, cloneRepo, findByName, recentRepos, recentReposCached } from "../src/runner/workspace.js";

let home = "";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdio: "ignore" });

async function repoAt(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "README.md"), "# hi\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "friday-home-"));
  await repoAt(path.join(home, "code", "api"));
  await mkdir(path.join(home, "code", "notes"), { recursive: true });
  await repoAt(path.join(home, "Desktop", "clients", "site"));
  await mkdir(path.join(home, "code", "node_modules", "junk"), { recursive: true });
});
after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("parseRepo reads owner/name, GitHub URLs and git URLs, and refuses flags", () => {
  assert.deepEqual(parseRepo("splashxmoon/Multiplayer-AI"), { slug: "splashxmoon/Multiplayer-AI", url: "https://github.com/splashxmoon/Multiplayer-AI.git", name: "Multiplayer-AI" });
  assert.equal(parseRepo("https://github.com/a/b/tree/main/src")?.slug, "a/b");
  assert.equal(parseRepo("git@github.com:a/b.git")?.url, "https://github.com/a/b.git");
  assert.equal(parseRepo("https://gitlab.com/team/proj.git")?.name, "proj");
  assert.equal(parseRepo("--upload-pack=touch /tmp/x"), null);
  assert.equal(parseRepo("-oops"), null);
  assert.equal(parseRepo("just words"), null);
});

test("recent repos come from the usual code folders, not from inside other repos or node_modules", async () => {
  const found = await recentRepos(24, home);
  const names = found.map((f) => f.name).sort();
  assert.deepEqual(names, ["api", "site"]);
  const api = found.find((f) => f.name === "api")!;
  assert.equal(api.isRepo, true);
  assert.equal(api.branch, "main");
});

test("the scan gives up on time rather than making someone wait, and the cache answers instantly", async () => {
  // A home directory can contain cloud-synced folders where one read takes
  // seconds. Whatever happens, the picker gets an answer straight away.
  const started = Date.now();
  const quick = await recentRepos(24, home, 1);
  assert.ok(Date.now() - started < 1000, "a 1ms budget returns at once");
  assert.ok(Array.isArray(quick));

  const t0 = Date.now();
  const first = await recentReposCached(home);
  assert.ok(Date.now() - t0 < 5000, "the first call is bounded by the scan budget");
  const t1 = Date.now();
  const second = await recentReposCached(home);
  assert.ok(Date.now() - t1 < 50, "the second is served from cache");
  assert.deepEqual(second.map((f) => f.path), first.map((f) => f.path));
});

test("a dropped folder is found by name, since a browser only knows the name", async () => {
  const hits = await findByName("site", home);
  assert.deepEqual(hits.map((h) => h.path), [path.join(home, "Desktop", "clients", "site")]);
  assert.deepEqual(await findByName("../etc", home), []);
});

test("browse lists subfolders with repos first", async () => {
  const b = await browse(path.join(home, "code"));
  assert.deepEqual(b.entries.map((e) => [e.name, e.isRepo]), [["api", true], ["notes", false]]);
  assert.equal(b.parent, home);
});

test("clone makes a working copy, and cloning again reuses it", async () => {
  const origin = path.join(home, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", path.join(home, "code", "api"), origin]);
  const parent = path.join(home, "Friday");
  const first = await cloneRepo(`file://${origin}`, parent);
  assert.equal(first.reused, false);
  assert.equal(first.path, path.join(parent, "origin"));
  assert.equal(first.isRepo, true);
  const again = await cloneRepo(`file://${origin}`, parent);
  assert.equal(again.reused, true);
  await assert.rejects(cloneRepo("--upload-pack=x", parent));
});

test("a CLI started from inside a Claude app session doesn't inherit that session's private channel or sign-in", () => {
  const env = childEnv({
    PATH: "/usr/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret",
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:52100",
    CLAUDE_CODE_OAUTH_TOKEN: "user-set",
    CLAUDE_CODE_USE_BEDROCK: "1",
  });
  assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "user-set");
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
  // Outside a host session, a person's own proxy setting is theirs to keep.
  assert.equal(childEnv({ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "http://localhost:8080" }).ANTHROPIC_BASE_URL, "http://localhost:8080");
  assert.ok(isClaudeAppBundled("/Users/a/Library/Application Support/Claude/claude-code/2.1.266/claude.app/Contents/MacOS/claude"));
  assert.ok(!isClaudeAppBundled("/opt/homebrew/bin/claude"));
});
