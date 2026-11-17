import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renameBranchOf } from "../src/runner/git.js";

const repo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-rename-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
  g("init", "-q", "-b", "fix/cart");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
  g("branch", "taken");
  return { dir, g };
};

test("the branch checked out is renamed, and the folder stays on it under its new name", async (t) => {
  const { dir, g } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await renameBranchOf(dir, "fix/cart-total"), { renamed: true, from: "fix/cart", branch: "fix/cart-total" });
  assert.equal(g("symbolic-ref", "--short", "HEAD"), "fix/cart-total");
});

test("a name git won't take, or one already used, is refused with why", async (t) => {
  const { dir } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(renameBranchOf(dir, "has space"), /branch name/);
  await assert.rejects(renameBranchOf(dir, "bad..name"), /branch name/);
  await assert.rejects(renameBranchOf(dir, "taken"), /is here already/);
});

test("the same name is no change", async (t) => {
  const { dir } = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await renameBranchOf(dir, "fix/cart"), { renamed: true, from: "fix/cart", branch: "fix/cart" });
});
