// Already failing at the start (src/baseline.ts; Arun, 2026-11-03: "Was it already broken?").
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { baseNote, baselineOf, commandKey, compare, failingTests, onlyPre, preNote } from "../src/baseline.js";
import type { SessionEvent } from "../src/types.js";

test("failing tests are read by name from the runners people use", () => {
  assert.deepEqual(failingTests("▶ api\n  ✔ ok (1ms)\n  ✖ retries a declined card (12.3ms)\n✖ failing tests:\n\n✖ retries a declined card (12.3ms)"), ["retries a declined card"]);
  assert.deepEqual(failingTests("TAP version 13\nnot ok 2 - parses dates # time=3ms\nok 3 - x"), ["parses dates"]);
  assert.deepEqual(failingTests("  ✕ adds tax (5 ms)\n  ● Cart › adds tax\n"), ["adds tax", "Cart › adds tax"]);
  assert.deepEqual(failingTests(" FAIL  src/cart.test.ts > Cart > adds tax\n × rounds down 3ms"), ["src/cart.test.ts > Cart > adds tax", "rounds down 3ms"]);
  assert.deepEqual(failingTests("FAILED tests/test_cart.py::test_tax - AssertionError: 1 != 2\nFAILED tests/test_cart.py::test_round"), ["tests/test_cart.py::test_tax", "tests/test_cart.py::test_round"]);
  assert.deepEqual(failingTests("--- FAIL: TestTax (0.00s)\nFAIL"), ["TestTax"]);
  assert.deepEqual(failingTests("test cart::tax ... FAILED\ntest cart::ok ... ok"), ["cart::tax"]);
  assert.deepEqual(failingTests("rspec ./spec/cart_spec.rb:12 # Cart adds tax"), ["Cart adds tax"]);
  assert.deepEqual(failingTests("1) Tests\\CartTest::testTax\nFailed asserting"), ["Tests\\CartTest::testTax"]);
  // Colour codes and a runner nobody can read.
  assert.deepEqual(failingTests("\u001b[31m✖ colourful\u001b[39m"), ["colourful"]);
  assert.equal(failingTests("Error: something broke\n1 error"), null);
});

test("a base run that couldn't be set up claims nothing; one that ran is kept with what failed", () => {
  const ran = baselineOf("npm test", "abc1234", "$ npm test\n(exited 1)\n✖ retries a declined card (2ms)\n");
  assert.deepEqual([ran.ok, ran.failing, ran.setup], [false, ["retries a declined card"], undefined]);
  assert.equal(baselineOf("npm test", "abc1234", "$ npm test\n(exited 0)\nall good").ok, true);
  assert.equal(baselineOf("npm test", "abc1234", "$ npm test\n(exited 1)\nError: Cannot find module 'vitest'").setup, true);
  assert.equal(baselineOf("npm test", "abc1234", "Couldn't make a copy at abc1234: bad object").setup, true);
  assert.equal(baselineOf("npm test", "abc1234", "This machine is connected in \"Manual\" mode, so commands can't be run on it.").setup, true);
  assert.equal(baselineOf("npm test", "abc1234", "$ npm test\n(timed out after 600s)\n").setup, true);
});

test("a command is kept as the suite it runs, not the filter on its output", () => {
  assert.equal(commandKey("npm test 2>&1 | tail -40"), "npm test");
  assert.equal(commandKey("  pnpm   vitest run  | grep -v PASS | head -n 80 "), "pnpm vitest run");
  assert.equal(commandKey("pytest -x -q"), "pytest -x -q");
});

test("a run's failures split into those that were there before and those that are new", () => {
  const base = baselineOf("npm test", "abc1234", "$ npm test\n(exited 1)\n✖ a\n✖ b\n");
  assert.deepEqual(compare(["a", "c"], base), { pre: ["a"], fresh: ["c"] });
  assert.equal(onlyPre(compare(["a", "b"], base)), true);
  assert.equal(onlyPre(compare(["a", "c"], base)), false);
  // Names on one side only: the whole command.
  const unnamed = baselineOf("make test", "abc1234", "$ make test\n(exited 2)\nboom");
  assert.deepEqual(compare(["a"], unnamed), { pre: [], fresh: [], whole: true });
  assert.equal(onlyPre(compare(null, unnamed)), true);
  const passed = baselineOf("npm test", "abc1234", "$ npm test\n(exited 0)\n");
  assert.deepEqual(compare(["a"], passed), { pre: [], fresh: ["a"] });
  assert.deepEqual(compare(null, passed), { pre: [], fresh: [], whole: false });
  assert.equal(compare(["a"], baselineOf("npm test", "abc1234", "$ npm test\n(exited 1)\nCannot find module 'x'")), null);
});

test("the agent is told once, on the turn right after, which failures aren't its own", () => {
  const ev = (seq: number, body: SessionEvent["body"]): SessionEvent => ({ seq, ts: seq, actor: { id: "x", name: "X", kind: "system" }, body, lane: "main" }) as SessionEvent;
  const said = ev(5, { type: "tests.base", run: 4, command: "npm test", base: "abc1234def", pre: ["a", "b"], fresh: [] });
  const log = [ev(1, { type: "run.started", causedBy: 0 } as SessionEvent["body"]), ev(4, { type: "run.ended", outcome: "done" } as SessionEvent["body"]), said];
  assert.equal(baseNote(log, "main"), "", "no turn has started since");
  const next = [...log, ev(6, { type: "run.started", causedBy: 0 } as SessionEvent["body"])];
  assert.match(baseNote(next, "main"), /already failed at abc1234[\s\S]*- a\n- b/);
  assert.equal(baseNote([...next, ev(9, { type: "run.started", causedBy: 0 } as SessionEvent["body"])], "main"), "", "only on the turn right after");
  assert.equal(baseNote(next, "other"), "");
  assert.match(preNote({ pre: [], fresh: [], whole: true }, "make test", "abc1234"), /already fails at abc1234/);
});

test("the runner runs a command where the repo stood at a commit, in a copy of its own, and leaves nothing behind", async () => {
  const { baseCopy, dropBaseCopy, treeOf } = await import("../src/runner/git.js");
  const repo = mkdtempSync(path.join(tmpdir(), "fb-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules\n.env\n");
  mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "x");
  writeFileSync(path.join(repo, ".env"), "PORT=3000\n");
  g("add", "-A");
  g("commit", "-qm", "one");
  const first = g("rev-parse", "HEAD");
  writeFileSync(path.join(repo, "a.txt"), "two\n");
  g("commit", "-qam", "two");
  assert.equal(await treeOf(repo, first), g("rev-parse", `${first}^{tree}`));
  const copy = await baseCopy(repo, first);
  try {
    // As git checks it out here: CRLF on Windows (core.autocrlf), as in the person's own checkout.
    assert.equal(readFileSync(path.join(copy.dir, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "one\n", "the file as it stood at the commit");
    assert.ok(lstatSync(path.join(copy.top, "node_modules")).isSymbolicLink(), "dependencies linked, not installed");
    assert.ok(existsSync(path.join(copy.top, ".env")), "its .env copied in");
  } finally {
    await dropBaseCopy(copy);
  }
  assert.equal(existsSync(copy.top), false, "the copy is gone");
  assert.ok(existsSync(path.join(repo, "node_modules", "dep", "index.js")), "and the folder's own dependencies are untouched");
  assert.equal(readdirSync(repo).includes("a.txt"), true);
  assert.equal(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n").length, 1);
});
