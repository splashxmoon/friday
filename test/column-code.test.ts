import assert from "node:assert/strict";
import test from "node:test";
import { codeFile, fenceAgrees } from "../src/client/ide/code-file.js";

// The file a block of code in Code's chat column names (ide/column-code.tsx), so "Open in file" is offered only where it is true.
test("a fence that names its file", () => {
  const r = codeFile("ts:src/cart.ts", "export const a = 1;");
  assert.equal(r.lang, "ts");
  assert.deepEqual(r.file, { path: "src/cart.ts" });
  assert.deepEqual(codeFile("python:ml/tune.py:42", "x = 1").file, { path: "ml/tune.py", line: 42 });
});

test("a first line that is only a path in a comment", () => {
  assert.deepEqual(codeFile("ts", "// src/api/prices.ts\nexport const a = 1;").file, { path: "src/api/prices.ts" });
  assert.deepEqual(codeFile("yaml", "# configs/model.yaml\nwindow_days: 14").file, { path: "configs/model.yaml" });
  assert.deepEqual(codeFile("css", "/* styles/app.css */\na { color: red }").file, { path: "styles/app.css" });
  assert.deepEqual(codeFile("sql", "-- db/up.sql\nselect 1;").file, { path: "db/up.sql" });
  assert.equal(codeFile("ts", "// file: src/x.ts\nlet a;").file?.path, "src/x.ts");
});

test("code that only looks a little like it names a file", () => {
  assert.equal(codeFile("bash", "npm test -- --watch").file, null);
  assert.equal(codeFile("ts", "// TODO: fix this later\nlet a;").file, null);
  assert.equal(codeFile("ts", "// the total\nlet a;").file, null);
  assert.equal(codeFile("ts", "// console.log\nlet a;").file, null);
  assert.equal(codeFile("python", "# Demo\nx = 1").file, null);
  assert.equal(codeFile("text", "").file, null);
  assert.equal(codeFile("ts:not a file", "x").file, null);
});

test("a fence with a colon keeps its language when the path is not accepted", () => {
  const abs = codeFile("ts:/Users/me/proj/src/a.ts", "x", null);
  assert.equal(abs.lang, "ts");
  assert.equal(abs.file, null);
  assert.equal(codeFile("ts:C:\\Users\\me\\a.ts", "x", null).lang, "ts");
  // Inside the open folder the whole path is that file.
  assert.deepEqual(codeFile("ts:/Users/me/proj/src/a.ts", "x", "/Users/me/proj").file, { path: "src/a.ts" });
  assert.deepEqual(codeFile("ts:/Users/me/proj/src/a.ts:12", "x", "/Users/me/proj").file, { path: "src/a.ts", line: 12 });
  assert.equal(codeFile("ts:/Users/me/other/a.ts", "x", "/Users/me/proj").file, null);
});

test("a Markdown heading is not a file comment", () => {
  for (const h of ["# Next.js", "# Node.js", "# README.md", "# CHANGELOG.md"]) {
    assert.equal(codeFile("md", `${h}\ntext`).file, null, h);
    assert.equal(codeFile("markdown", `${h}\ntext`).file, null, h);
    assert.equal(codeFile("", `${h}\ntext`).file, null, h);
    assert.equal(codeFile("bash", `${h}\ntext`).file, null, h);
  }
  assert.deepEqual(codeFile("yaml", "# configs/model.yaml\nx: 1").file, { path: "configs/model.yaml" });
});

test("a fence's language and the file it sits above", () => {
  assert.equal(fenceAgrees("bash", "src/cart.ts"), false);
  assert.equal(fenceAgrees("ts", "src/cart.ts"), true);
  assert.equal(fenceAgrees("typescript", "src/cart.tsx"), true);
  assert.equal(fenceAgrees("", "src/cart.ts"), true);
  assert.equal(fenceAgrees("json", "package.json"), true);
  assert.equal(fenceAgrees("sh", "scripts/a.ts"), false);
});
