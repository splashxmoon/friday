import assert from "node:assert/strict";
import test from "node:test";
import { inFolder, lastWords } from "../src/client/Tasks.js";

/** A finished command in the Tasks list: read relative to the project, and a failure by its own last words. */

test("the project's own path is taken out of a command, in either slash, quoted or not", () => {
  const folders = ["C:\\Users\\Arun Dass\\Desktop\\edge enterprise"];
  assert.equal(inFolder('cat "C:/Users/Arun Dass/Desktop/edge enterprise/ml/tuning_results.json"', folders), "cat ml/tuning_results.json");
  assert.equal(inFolder('python "C:\\Users\\Arun Dass\\Desktop\\edge enterprise\\ml\\_check.py"', folders), "python ml\\_check.py");
  assert.equal(inFolder("npm test", folders), "npm test", "nothing to take out, nothing changes");
  assert.equal(inFolder('cat "/other/place/x.json"', folders), "cat /other/place/x.json");
  assert.equal(inFolder('echo "hello world"', folders), 'echo "hello world"', "quotes that are needed stay");
});

test("a failure's last words: the error line, without colour codes, stack frames or PowerShell's trailing detail", () => {
  assert.equal(lastWords("Traceback (most recent call last):\n  File \"x.py\", line 1\nFileNotFoundError: [Errno 2] No such file: 'ml/x.json'\n"), "FileNotFoundError: [Errno 2] No such file: 'ml/x.json'");
  assert.equal(lastWords("\u001b[31merror\u001b[0m: tests failed\n\n"), "error: tests failed");
  assert.equal(
    lastWords("cat : Cannot find path 'C:\\x' because it does not exist.\n    + CategoryInfo          : ObjectNotFound\n    + FullyQualifiedErrorId : PathNotFound"),
    "cat : Cannot find path 'C:\\x' because it does not exist.",
  );
  assert.equal(lastWords("Error: boom\n    at main (a.js:1:1)\n    at run (b.js:2:2)"), "Error: boom");
  assert.equal(lastWords(""), "");
});
