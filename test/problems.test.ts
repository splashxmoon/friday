import assert from "node:assert/strict";
import { test } from "node:test";
import { problemsIn, scriptsIn } from "../src/client/Problems.js";

/**
 * A failing build says what is wrong and where. Turning that back into a place
 * in the code is the whole value — and getting it wrong is worse than not
 * trying, because a row that opens the wrong file costs more than reading the
 * sentence would have.
 */

test("the shapes real tools print errors in become places in the code", () => {
  const tsc = problemsIn(`
> tsc --noEmit
src/client/Tree.tsx(212,9): error TS2322: Type 'string' is not assignable to type 'number'.
src/app.ts(4,1): warning TS6133: 'x' is declared but never read.
`);
  assert.deepEqual(tsc, [
    { path: "src/client/Tree.tsx", line: 212, column: 9, severity: "error", message: "Type 'string' is not assignable to type 'number'." },
    { path: "src/app.ts", line: 4, column: 1, severity: "warning", message: "'x' is declared but never read." },
  ]);

  // The unix shape: eslint, clang, go, rust.
  const unix = problemsIn("src/main.rs:12:5: error: cannot borrow `x` as mutable\n");
  assert.deepEqual(unix, [{ path: "src/main.rs", line: 12, column: 5, severity: "error", message: "cannot borrow `x` as mutable" }]);

  // Python puts the message two lines below the place.
  const py = problemsIn(`Traceback (most recent call last):
  File "app/main.py", line 42, in handler
    raise ValueError(x)
ValueError: no such thing
`);
  assert.deepEqual(py, [{ path: "app/main.py", line: 42, severity: "error", message: "ValueError: no such thing" }]);
});

test("a stack is one fault, not one row per frame", () => {
  const found = problemsIn(`
Error: boom
    at run (/repo/src/server.ts:31:11)
    at go (/repo/src/server.ts:44:3)
    at node:internal/main/run:12:3
`, "/repo");
  assert.equal(found.length, 1, "the first frame is the fault; the rest is the path it took");
  assert.deepEqual(found[0], { path: "src/server.ts", line: 31, column: 11, severity: "error", message: "threw here" });
});

test("what isn't in the folder isn't offered", () => {
  // A path outside the folder can't be opened in the tree, so it isn't a row.
  assert.deepEqual(problemsIn("/usr/lib/node/thing.js:3:1: error: nope\n"), []);
  assert.deepEqual(problemsIn("node:internal/modules/cjs:1:1: error: nope\n"), []);
  // And a command that simply worked has nothing to say.
  assert.deepEqual(problemsIn("$ npm test\nall good\n(exited 0)"), []);
});

test("the same mistake said twice is one row", () => {
  const twice = problemsIn(`src/a.ts(1,1): error TS1: broken
src/a.ts(1,1): error TS1: broken
`);
  assert.equal(twice.length, 1);
});

test("a project's own commands are read from its files, not guessed at", () => {
  const found = scriptsIn([
    {
      path: "package.json",
      text: JSON.stringify({ scripts: { test: "node --test", build: "tsc", "test:watch": "node --test --watch", prepublishOnly: "x", postinstall: "y" } }),
    },
  ]);
  assert.deepEqual(
    found.map((s) => s.run),
    ["npm run test", "npm run build", "npm run test:watch"],
    "the handful people actually run, and not the lifecycle hooks",
  );

  const make = scriptsIn([{ path: "Makefile", text: "build:\n\tgo build\n\nVAR := 1\ntest:\n\tgo test\n" }]);
  assert.deepEqual(
    make.map((s) => s.run),
    ["make build", "make test"],
    "a variable assignment is not a target",
  );

  assert.deepEqual(scriptsIn([{ path: "package.json", text: "{ not json" }]), [], "a file it cannot read offers nothing rather than throwing");
});
