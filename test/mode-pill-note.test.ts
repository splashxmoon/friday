import assert from "node:assert/strict";
import test from "node:test";
import { switchNote } from "../src/client/Activity.js";

// After a question-only run the mode went back to the one picked by hand, and the mode pill's hover kept saying "Auto, the run it
// was switched for is over" from then on (2026-11-04 retest). A switch away from your mode says why; back in yours, nothing.
test("the mode pill explains a switch away from your mode, and says nothing once it is back in yours", () => {
  assert.equal(switchNote({ mode: "plan", why: "it's a question" }, "auto", "Plan"), "Plan, it's a question");
  assert.equal(switchNote({ mode: "auto", why: "the run it was switched for is over" }, "auto", "Auto"), null);
});
