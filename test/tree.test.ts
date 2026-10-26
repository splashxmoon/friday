import assert from "node:assert/strict";
import { test } from "node:test";
import { flatten, parseTree, relativise, resolvePath, type TreeFacts } from "../src/client/Tree.js";
import type { DiffFile } from "../src/types.js";

/**
 * The tree view: the folder as the machine reports it, with what the session
 * knows drawn on top. These are the parts that have to be right before any of
 * it is drawn — what came back from the machine, which rows that makes, and
 * whether a path an agent mentioned is the same file the machine listed.
 */

const OUT = `4 files under the repository root:
src/app.ts
src/util/dates.ts
README.md
package.json`;

const facts = (changed: string[] = []): TreeFacts => ({
  paths: [],
  changed: new Map(changed.map((p) => [p, { file: { path: p, status: "modified", additions: 3, deletions: 1, patch: "" } as DiffFile, lane: "main" }])),
  touched: new Map(),
  where: null,
});

test("the machine's listing becomes paths, and its prose does not", () => {
  assert.deepEqual(parseTree(OUT), ["src/app.ts", "src/util/dates.ts", "README.md", "package.json"]);
  assert.deepEqual(parseTree("0 files under the repository root:\n(no files)"), []);
  assert.deepEqual(parseTree("2 files under src:\na.ts\nb.ts\n\n[listing stopped at 400 files]"), ["a.ts", "b.ts"]);
});

test("rows are folders first, then files, and only what is open", () => {
  const paths = parseTree(OUT);
  const shut = flatten(paths, facts(), { q: "", onlyChanged: false, open: new Set() });
  assert.deepEqual(
    shut.map((r) => [r.name, r.dir]),
    [
      ["src", true],
      ["package.json", false],
      ["README.md", false],
    ],
    "a closed folder is one row, folders sort above files, and names sort as a person reads them",
  );

  const open = flatten(paths, facts(), { q: "", onlyChanged: false, open: new Set(["src"]) });
  assert.deepEqual(
    open.map((r) => [r.name, r.depth]),
    [
      ["src", 0],
      ["util", 1],
      ["app.ts", 1],
      ["package.json", 0],
      ["README.md", 0],
    ],
    "opening src reveals its children, and no deeper",
  );

  // A closed folder still says how much changed inside it, or the count would
  // only exist for people who had already found it.
  const withChange = flatten(paths, facts(["src/util/dates.ts"]), { q: "", onlyChanged: false, open: new Set() });
  assert.equal(withChange.find((r) => r.name === "src")!.changed, 1);
});

test("searching and filtering answer a different question, so they answer it flat", () => {
  const paths = parseTree(OUT);
  const found = flatten(paths, facts(), { q: "dates", onlyChanged: false, open: new Set() });
  assert.deepEqual(found.map((r) => [r.path, r.depth]), [["src/util/dates.ts", 0]], "the full path, at the top level, with nothing to unfold");

  const only = flatten(paths, facts(["README.md"]), { q: "", onlyChanged: true, open: new Set() });
  assert.deepEqual(only.map((r) => r.path), ["README.md"]);
  assert.deepEqual(flatten(paths, facts(), { q: "nothing", onlyChanged: false, open: new Set() }), []);
});

test("a path an agent mentions is matched to the file the machine listed, however it spelled it", () => {
  const paths = parseTree(OUT);
  assert.equal(relativise("src/app.ts", paths), "src/app.ts");
  assert.equal(relativise("./src/app.ts", paths), "src/app.ts");
  assert.equal(relativise("/Users/ada/code/demo/src/app.ts", paths), "src/app.ts");
  assert.equal(relativise("C:\\Users\\ada\\demo\\src\\app.ts", paths), "src/app.ts");
  assert.equal(relativise("src/elsewhere.ts", paths), null, "a file the machine didn't list is not invented");
  assert.equal(relativise("", paths), null);
});

test("a file named by itself in an answer opens the file of that name in the folder", () => {
  const paths = ["README.md", "ml/train.py", "ml/old/train.py", "server/app.ts", "app.ts"];
  assert.equal(resolvePath(paths, "train.py"), "ml/train.py", "the one nearest the top");
  assert.equal(resolvePath(paths, "app.ts"), "app.ts", "a path that is there is itself");
  assert.equal(resolvePath(paths, "old/train.py"), "ml/old/train.py", "a partial path too");
  assert.equal(resolvePath(paths, "rain.py"), "rain.py", "not a file whose name only ends the same");
  assert.equal(resolvePath(paths, "nope.py"), "nope.py", "and nothing made up");
});
