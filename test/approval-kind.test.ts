import { test } from "node:test";
import assert from "node:assert/strict";
import { restatesKind } from "../src/client/Activity.js";

// A permission card says a command's kind once: a tool's reason that only says it again is left off (audit CODE-21 A).
test("a reason that only restates the command's kind is not said twice", () => {
  assert.equal(restatesKind("This command deletes files", ["rm -rf build"]), true);
  assert.equal(restatesKind("Runs the tests", ["npm test"]), true);
  assert.equal(restatesKind("The build folder is stale and confuses the bundler", ["rm -rf build"]), false);
  assert.equal(restatesKind("This command deletes files", ["ls -la"]), false);
});
