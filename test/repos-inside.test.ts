// A teammate's folder that isn't a repository but holds some (Arun, 2026-11-03: the Manager in ~/Desktop/edge, working in the
// repository edge/edge, showed one "Subproject commit …-dirty" line and Claude Code's scheduled_tasks.lock as its changes).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { diffSince, reposInside, shadowSnapshot } from "../src/runner/git.js";

let dir = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "friday-inside-"));
  for (const r of ["edge", "apps/site"]) {
    await mkdir(path.join(dir, r), { recursive: true });
    git(path.join(dir, r), "init", "-q");
    await writeFile(path.join(dir, r, "a.txt"), "one\n");
    git(path.join(dir, r), "add", "-A");
    git(path.join(dir, r), "commit", "-q", "-m", "first");
  }
  await mkdir(path.join(dir, "node_modules", "dep"), { recursive: true });
  git(path.join(dir, "node_modules", "dep"), "init", "-q");
  await mkdir(path.join(dir, "notes"), { recursive: true });
  await writeFile(path.join(dir, "notes", "plan.md"), "plan\n");
});
after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

test("the repositories inside a folder that isn't one are found, two levels down, never in node_modules", async () => {
  const found = (await reposInside(dir)).map((d) => path.relative(dir, d)).sort();
  assert.deepEqual(found, ["apps/site", "edge"]);
});

test("Claude Code's scheduled-tasks lock and .DS_Store are nobody's change", async () => {
  const shadow = await shadowSnapshot(dir);
  assert.ok(shadow);
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "scheduled_tasks.lock"), "{}\n");
  await writeFile(path.join(dir, "notes", ".DS_Store"), "x");
  await writeFile(path.join(dir, "notes", "plan.md"), "plan, changed\n");
  const files = (await diffSince(dir, shadow.head, shadow)).map((f) => f.path);
  assert.ok(files.includes("notes/plan.md"));
  assert.ok(!files.some((f) => f.endsWith(".DS_Store") || f === ".claude/scheduled_tasks.lock"), files.join(", "));
});
