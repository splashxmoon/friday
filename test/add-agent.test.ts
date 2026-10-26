import assert from "node:assert/strict";
import { test } from "node:test";

test("adding an agent offers a folder once, not once for every agent's copy of it", async () => {
  const { isCopyOf } = await import("../src/client/Engine.js");
  const all = ["/Users/a/.friday/worktrees/edge-b37001cc", "/Users/a/.friday/worktrees/edge-b37001cc-d41d587d", "/Users/a/.friday/worktrees/edge-b37001cc-3854d945/", "/Users/a/code/site"];
  assert.equal(isCopyOf(all[1]!, all), true, "an agent's copy beside the folder it copies");
  assert.equal(isCopyOf(all[2]!, all), true, "with a trailing slash too");
  assert.equal(isCopyOf(all[0]!, all), false, "the folder itself, whose original isn't in the list");
  assert.equal(isCopyOf(all[3]!, all), false);
  assert.equal(isCopyOf("/Users/a/code/site-deadbeef", ["/Users/a/code/other"]), false, "a name that looks like a copy, of nothing here");
});
