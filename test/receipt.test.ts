import assert from "node:assert/strict";
import test from "node:test";
import { receiptOf } from "../src/receipt.js";
import type { DiffFile } from "../src/types.js";

const run = (id: string, command: string) => ({ id, name: "run_command", arguments: JSON.stringify({ command }) });
const file = (path: string, patch = "", o: Partial<DiffFile> = {}): DiffFile => ({ path, status: "modified", additions: 1, deletions: 0, patch, ...o });

test("a run that ran its tests and they passed has no flags", () => {
  const r = receiptOf({ calls: [run("a", "npm test")], failed: () => false, files: [file("src/a.ts")], answer: "Fixed it; the tests pass." });
  assert.equal(r.tests, "pass");
  assert.deepEqual(r.flags, []);
});

test("a test that failed and was then fixed counts as passing, and both attempts are on the receipt", () => {
  const r = receiptOf({ calls: [run("a", "npm test"), run("b", "npm test")], failed: (id) => id === "a", files: [], });
  assert.equal(r.tests, "pass");
  assert.deepEqual(r.commands.map((c) => c.ok), [false, true]);
});

test("claiming success with no test command is flagged, and so is claiming it over a failure", () => {
  const none = receiptOf({ calls: [], failed: () => false, files: [file("src/a.ts")], answer: "All tests pass now." });
  assert.equal(none.tests, "none");
  assert.match(none.flags[0]!.text, /ran no test command/);
  const failing = receiptOf({ calls: [run("a", "pytest")], failed: () => true, files: [], answer: "The suite is green." });
  assert.equal(failing.flags[0]!.level, "bad");
  assert.match(failing.flags[0]!.text, /last test run failed/);
});

test("the quiet ways to make a check go green are flagged: silenced, swallowed, loosened, ignored in CI", () => {
  const r = receiptOf({
    calls: [run("a", "npm test")],
    failed: () => false,
    files: [
      file("src/a.ts", "+  // @ts-ignore\n+  const x: number = load();"),
      file("src/b.py", "+    try:\n+        risky()\n+    except Exception:  pass"),
      file("src/total.test.ts", "-  expect(total(cart)).toEqual(42);\n+  expect(total(cart)).toBeTruthy();", { additions: 1, deletions: 1 }),
      file(".github/workflows/ci.yml", "+        continue-on-error: true"),
      file("src/c.ts", "+  } catch (e) {}"),
    ],
  });
  const texts = r.flags.map((f) => `${f.level}: ${f.text}`);
  assert.ok(texts.includes("warn: Silenced a type or lint check in src/a.ts"), texts.join(" | "));
  assert.ok(texts.includes("warn: Catches an error and ignores it in src/b.py"));
  assert.ok(texts.includes("warn: Catches an error and ignores it in src/c.ts"));
  assert.ok(texts.includes("bad: Loosened an assertion in src/total.test.ts"), "an exact value swapped for 'something is there'");
  assert.ok(texts.includes("bad: Made a check pass whatever happens in .github/workflows/ci.yml"));
  assert.equal(r.flags[0]!.level, "bad", "the worst first");

  const fair = receiptOf({
    calls: [run("a", "npm test")],
    failed: () => false,
    files: [file("src/total.test.ts", "-  expect(total(cart)).toEqual(41);\n+  expect(total(cart)).toEqual(42);"), file("src/d.ts", "+  .catch((e) => log(e))")],
  });
  assert.deepEqual(fair.flags, [], "changing what a test expects, or handling an error, is ordinary work");
});

test("weakening a test is the loudest flag", () => {
  const r = receiptOf({
    calls: [run("a", "npm test")],
    failed: () => false,
    files: [
      file("src/a.test.ts", "+  it.skip('keeps the total', () => {"),
      file("test/b.test.ts", "", { status: "deleted", additions: 0, deletions: 20 }),
      file("src/c.ts", "+  xit('later')"),
    ],
  });
  assert.equal(r.tests, "pass");
  assert.deepEqual(
    r.flags.map((f) => f.level),
    ["bad", "bad", "bad"],
  );
  assert.ok(r.flags.some((f) => /Deleted the test file test\/b\.test\.ts/.test(f.text)));
  assert.ok(r.flags.some((f) => /src\/c\.ts/.test(f.text)), "a skip in a file not named like a test is still a skipped test");
});

test("changing only docs and styles is no reason to ask for tests", () => {
  const r = receiptOf({ calls: [], failed: () => false, files: [file("README.md"), file("public/style.css")] });
  assert.deepEqual(r.flags, []);
  const code = receiptOf({ calls: [], failed: () => false, files: [file("src/a.ts")] });
  assert.match(code.flags[0]!.text, /ran no tests/);
});

test("a test that crashed inside a chain is a failure, though the chain exited 0", async () => {
  const { testFailedInChain } = await import("../src/receipt.js");
  const crashed = "> todo-app@1.0.0 test\n> node test.js\n\nnode:fs:2729\n\nError: EPERM: operation not permitted, lstat 'C:\Users\Arun Dass'\n    at Object.realpathSync";
  // What Codex ran in a real session: git diff's success hid the suite's crash, and the card said "Tests passed".
  assert.equal(testFailedInChain("npm test; git diff -- index.js test.js", crashed), true);
  assert.equal(testFailedInChain("pytest || true", "=== 2 failed, 10 passed in 1.2s ==="), true);
  assert.equal(testFailedInChain("npm test; git status", "> node test.js\nok\n## main"), false, "a pass is still a pass");
  assert.equal(testFailedInChain("npm test", crashed), false, "not chained: the exit status already said so");
  assert.equal(testFailedInChain("ls; cat error.log", "Error: something"), false, "not a test");
  assert.equal(testFailedInChain("npm test && git diff", crashed), false, "&& stops at the failure, so its status is the test's");

  const { codexExec } = await import("../src/runner/adapters.js");
  const parse = codexExec.parser();
  const out = parse(JSON.stringify({ type: "item.completed", item: { id: "c", type: "command_execution", command: "npm test; git diff", aggregated_output: crashed, exit_code: 0, status: "completed" } }));
  assert.equal((out.find((o) => o.kind === "result") as { isError: boolean }).isError, true, "and the agent's own log says it failed");
});
