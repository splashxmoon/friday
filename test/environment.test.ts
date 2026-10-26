import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** A session's environment on someone's computer (runner/environment.ts): what is kept for a folder, and what is said of it. */

const home = mkdtempSync(path.join(os.tmpdir(), "friday-env-home-"));
process.env.HOME = home;
const { describeEnvironment, folderSetup, folderVars, saveEnvironment } = await import("../src/runner/environment.js");
test.after(() => rmSync(home, { recursive: true, force: true }));

const project = () => {
  const dir = mkdtempSync(path.join(home, "project-"));
  mkdirSync(path.join(dir, ".git"));
  return dir;
};

test("variables kept for a folder reach what runs there, never over PATH or HOME, and a value sent back unchanged stays", () => {
  const dir = project();
  assert.throws(() => saveEnvironment(dir, { vars: { PATH: "/nowhere" } }), /how commands find their tools/);
  assert.throws(() => saveEnvironment(dir, { vars: { "1BAD": "x" } }), /letters, digits and _/);
  const saved = saveEnvironment(dir, { setup: "  npm install  ", vars: { API_URL: "https://staging", TOKEN: "s3cret" } });
  assert.deepEqual(saved.vars, ["API_URL", "TOKEN"], "only names come back");
  assert.equal(saved.setup, "npm install");
  assert.deepEqual(folderVars(dir), { API_URL: "https://staging", TOKEN: "s3cret" });
  // The page never holds a value: it sends null for the ones it didn't change, and an empty one to drop it.
  saveEnvironment(dir, { vars: { API_URL: "https://prod", TOKEN: null } });
  assert.deepEqual(folderVars(dir), { API_URL: "https://prod", TOKEN: "s3cret" });
  saveEnvironment(dir, { vars: { API_URL: null } });
  assert.deepEqual(folderVars(dir), { API_URL: "https://prod" });
  assert.deepEqual(folderVars(undefined), {});
});

test("what is kept is the owner's alone, in their home, never in the folder", () => {
  const dir = project();
  saveEnvironment(dir, { vars: { KEY: "v" } });
  const kept = path.join(home, ".friday", "environments");
  assert.equal(statSync(kept).mode & 0o777, 0o700);
  for (const f of readdirSync(kept)) assert.equal(statSync(path.join(kept, f)).mode & 0o777, 0o600, `${f} is read by its owner only`);
  for (const f of ["env", ".friday.json", "environment.json"]) assert.throws(() => statSync(path.join(dir, f)), { code: "ENOENT" }, `nothing written in the folder (${f})`);
});

test("a separate copy of a repository shares its settings", () => {
  const repo = project();
  const copy = mkdtempSync(path.join(home, "copy-"));
  writeFileSync(path.join(copy, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "agent")}\n`);
  saveEnvironment(repo, { setup: "pnpm install", autoSetup: true, vars: { SHARED: "yes" } });
  assert.deepEqual(folderVars(copy), { SHARED: "yes" });
  assert.deepEqual(folderSetup(copy), { setup: "pnpm install", autoSetup: true });
});

test("the environment says the machine, the project's tools and the names an .env sets, never a value", async () => {
  const dir = project();
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", engines: { node: ">=20" } }));
  writeFileSync(path.join(dir, ".env.local"), "DATABASE_URL=postgres://user:pass@host/db\nexport STRIPE_KEY=sk_test_123\n# COMMENT=no\n");
  saveEnvironment(dir, { vars: { HIDDEN: "value" } });
  const e = await describeEnvironment(dir);
  assert.ok(e.machine.name && e.machine.os && e.machine.cpus > 0);
  assert.ok(e.tools.some((t) => t.name === "Node.js" && t.wants === ">=20"), "node, with what package.json asks for");
  assert.ok(e.tools.some((t) => t.name === "npm"));
  assert.deepEqual(e.envFiles, [{ file: ".env.local", names: ["DATABASE_URL", "STRIPE_KEY"] }]);
  assert.deepEqual(e.saved.vars, ["HIDDEN"]);
  const said = JSON.stringify(e);
  for (const secret of ["postgres://", "sk_test_123", "value\""]) assert.ok(!said.includes(secret), `no value said: ${secret}`);
});
