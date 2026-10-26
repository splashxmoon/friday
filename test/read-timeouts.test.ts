import assert from "node:assert/strict";
import test from "node:test";
import { readTimeoutFor } from "../src/engine/hub.js";

/**
 * A request to somebody's machine used to be given up on after 20 seconds
 * whatever it was, which is shorter than the two minutes the machine allows a
 * command. A build or an install that was working was reported as "didn't
 * answer in time".
 */
test("a command may take as long as the machine allows it, and a quick question still gives up quickly", () => {
  assert.ok(readTimeoutFor("shell") >= 120_000, "longer than the runner's own command limit");
  assert.ok(readTimeoutFor("preview") > 15_000, "the preview answers within 15s, so this never cuts it off");
  assert.equal(readTimeoutFor("read"), 20_000);
  assert.equal(readTimeoutFor("tree"), 20_000);
  assert.ok(readTimeoutFor("publish") > readTimeoutFor("commit"));
});
