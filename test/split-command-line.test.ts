import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCommandLine, splitCommandLine } from "../src/runner/adapters.js";

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

test("splitCommandLine: quoted flags with spaces", () => {
  assert.deepEqual(
    splitCommandLine('goose acp --dir="C:\\My Projects"'),
    ["goose", "acp", "--dir=C:\\My Projects"]
  );
  assert.deepEqual(
    splitCommandLine("agent --flag='single with spaces'"),
    ["agent", "--flag=single with spaces"]
  );
});

test("splitCommandLine: escaped quotes inside double quotes", () => {
  assert.deepEqual(
    splitCommandLine('agent "hello \\\"world\\\""'),
    ["agent", 'hello "world"']
  );
});

test("splitCommandLine: empty quoted arguments", () => {
  assert.deepEqual(splitCommandLine("agent \"\" ''"), ["agent", "", ""]);
  assert.deepEqual(splitCommandLine('agent --flag=""'), ["agent", "--flag="]);
});

test("splitCommandLine: unclosed quotes throw", () => {
  assert.throws(
    () => splitCommandLine('agent "hello world'),
    /Unclosed " in the command line/
  );
  assert.throws(
    () => splitCommandLine("agent 'hello world"),
    /Unclosed ' in the command line/
  );
  assert.throws(
    () => splitCommandLine('run "oops'),
    /Unclosed " in the command line/
  );
});

test("splitCommandLine: quote inside a word", () => {
  assert.deepEqual(splitCommandLine('--name="my name"'), ["--name=my name"]);
});

test("splitCommandLine: preserves UNC backslashes in quoted Windows paths", () => {
  assert.deepEqual(
    splitCommandLine('"\\\\server\\share\\agent.exe" --acp'),
    ["\\\\server\\share\\agent.exe", "--acp"]
  );
  assert.deepEqual(
    splitCommandLine('"\\\\server\\share\\my agent.exe" --flag'),
    ["\\\\server\\share\\my agent.exe", "--flag"]
  );
});

test("formatCommandLine and splitCommandLine round-trip arguments with quotes and spaces", () => {
  const cmd = "agent";
  const args = ['hello "world"', "with space", "--dir=C:\\My Projects", "", "it's", "C:\\My Dir\\"];
  const formatted = formatCommandLine(cmd, args);
  assert.equal(formatted, 'agent "hello \\\"world\\\"" "with space" "--dir=C:\\My Projects" "" "it\'s" "C:\\My Dir\\\\"');
  assert.deepEqual(splitCommandLine(formatted), [cmd, ...args]);
});
