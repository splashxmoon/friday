import assert from "node:assert/strict";
import { test } from "node:test";
import { splitCommandLine } from "../src/runner/adapters.js";

test("splitCommandLine: plain words separated by spaces", () => {
  assert.deepEqual(splitCommandLine("foo bar baz"), ["foo", "bar", "baz"]);
  assert.deepEqual(splitCommandLine("goose acp"), ["goose", "acp"]);
});

test("splitCommandLine: double-quoted argument with spaces", () => {
  assert.deepEqual(
    splitCommandLine('"C:\\Tools\\my agent.exe" --acp'),
    ["C:\\Tools\\my agent.exe", "--acp"]
  );
  assert.deepEqual(
    splitCommandLine('command "first argument" "second argument"'),
    ["command", "first argument", "second argument"]
  );
});

test("splitCommandLine: single-quoted argument", () => {
  assert.deepEqual(splitCommandLine("'hello world' test"), ["hello world", "test"]);
  assert.deepEqual(splitCommandLine("run 'single quoted'"), ["run", "single quoted"]);
});

test("splitCommandLine: empty string", () => {
  assert.deepEqual(splitCommandLine(""), []);
  assert.deepEqual(splitCommandLine("   "), []);
});

test("splitCommandLine: extra spaces between words", () => {
  assert.deepEqual(splitCommandLine("foo    bar   baz"), ["foo", "bar", "baz"]);
  assert.deepEqual(splitCommandLine("  leading and trailing  "), ["leading", "and", "trailing"]);
});

test("splitCommandLine: quoted path first and flags after", () => {
  assert.deepEqual(
    splitCommandLine('"/usr/local/bin/agent tool" -v --flag --mode=fast'),
    ["/usr/local/bin/agent tool", "-v", "--flag", "--mode=fast"]
  );
  assert.deepEqual(
    splitCommandLine("'C:\\Program Files\\app.exe' -f --name 'my name'"),
    ["C:\\Program Files\\app.exe", "-f", "--name", "my name"]
  );
});

test("splitCommandLine: unbalanced quote records current behavior", () => {
  assert.deepEqual(splitCommandLine('run "oops'), ["run", '"oops']);
});

test("splitCommandLine: quote inside a word records current behavior", () => {
  assert.deepEqual(splitCommandLine('--name="my name"'), ['--name="my', 'name"']);
});
