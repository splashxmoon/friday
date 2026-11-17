// An agent briefed from its repo's Deep Dive (deep-dive.ts diveBrief): the overview without diagrams, then where each part lives.
import assert from "node:assert/strict";
import { test } from "node:test";
import { diveBrief } from "../src/deep-dive.js";

const page = (title: string, body: string, files: string[], status: "done" | "failed" = "done") => ({ title, purpose: `What ${title} is for`, files, body, status });

test("the overview and every other page by where it lives; nothing until the Deep Dive is ready", () => {
  const d = { status: "ready" as const, head: "a1b2c3d4e5f6", branch: "main", name: "shop" };
  const pages = [page("Overview", "Shop sells things.\n\n```mermaid\ngraph TD; A-->B\n```\n\nCheckout is in src/cart.", []), page("Checkout", "…", ["src/cart.ts", "src/totals.ts"]), page("Broken", "", ["x.ts"], "failed")];
  const b = diveBrief(d, pages);
  assert.match(b, /shop has a Deep Dive, written at a1b2c3d on main/);
  assert.match(b, /Shop sells things\.[\s\S]*Checkout is in src\/cart\./);
  assert.doesNotMatch(b, /mermaid|graph TD/, "no diagrams in an agent's brief");
  assert.match(b, /- Checkout: What Checkout is for \(src\/cart\.ts, src\/totals\.ts\)/);
  assert.doesNotMatch(b, /Broken/, "a page that failed isn't offered");
  assert.equal(diveBrief({ ...d, status: "building" as never }, pages), "");
  assert.ok(diveBrief(d, [page("Overview", "x".repeat(9000), [])]).length < 3000, "the overview is cut short");
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pageStale } from "../src/deep-dive.js";
import { changedSince } from "../src/runner/dive.js";

test("a page is out of date when a file under it changed in a commit since, or was edited in the folder after it was written", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-dive-stale-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src/cart.ts"), "a\n");
  writeFileSync(path.join(dir, "src/totals.ts"), "b\n");
  writeFileSync(path.join(dir, "README.md"), "c\n");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "one");
  const written = git("rev-parse", "HEAD");
  writeFileSync(path.join(dir, "src/cart.ts"), "a2\n");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-am", "two");
  const at = Date.now() - 60_000;
  writeFileSync(path.join(dir, "README.md"), "c2\n");
  const c = await changedSince(dir, written);
  assert.deepEqual(c.committed, ["src/cart.ts"]);
  assert.deepEqual(c.dirty.map((x) => x.path), ["README.md"]);
  assert.equal(pageStale({ files: ["src/cart.ts"], at }, c), true, "changed in a commit since");
  assert.equal(pageStale({ files: ["src"], at }, c), true, "a folder the page covers");
  assert.equal(pageStale({ files: ["src/totals.ts"], at }, c), false);
  assert.equal(pageStale({ files: ["README.md"], at }, c), true, "edited in the folder after it was written");
  assert.equal(pageStale({ files: ["README.md"], at: Date.now() + 60_000 }, c), false, "refreshed after the edit: not out of date for it");
  assert.deepEqual((await changedSince(dir, git("rev-parse", "HEAD"))).committed, [], "written at the head: no commits since");
});
