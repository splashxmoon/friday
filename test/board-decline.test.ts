import assert from "node:assert/strict";
import test from "node:test";
import { reviewPasses, reviewVerdict } from "../src/agent-mesh.js";

/** A review's verdict (agent-mesh.ts reviewPasses): approved passes, a named problem goes back, and one naming nothing is no pass. */
test("approved passes, a named problem goes back, a review naming no problem doesn't pass", () => {
  assert.equal(reviewPasses("Approved. Clean change."), true);
  assert.equal(reviewPasses("LGTM"), true);
  assert.equal(reviewPasses("Changes needed: the totals test fails on mobile."), false);
  assert.equal(reviewPasses("The rounding is wrong for JPY, and a test is missing."), false);
  // No verdict said either way: not let through unread (Arun, 2026-11-13: "air tight"); asked again, then back with its words.
  assert.equal(reviewPasses("Here's my review, structured for the team. Read the spec and the screens; they follow the brief."), false, "no verdict: not a pass");
  assert.equal(reviewVerdict("Here's my review, structured for the team. Read the spec and the screens; they follow the brief."), "unclear");
  assert.equal(reviewVerdict(""), "unclear", "nothing said: no verdict");
  assert.equal(reviewPasses("Looks good, but the null case is broken."), false);
  assert.equal(reviewPasses("All good except a bug in the retry path."), false);
  assert.equal(reviewPasses("Approved. Note: the toast copy could be shorter."), true, "notes after Approved still pass");
});

test("a review that names a problem in its own words sends the work back; one that found nothing wrong lets it through", () => {
  // 2026-10-21: "Found a problem: ... a double tap creates two charges" had passed, as only "bug", "missing" or "fails" counted.
  assert.equal(reviewPasses("Found a problem: the intent is created without an idempotency key, so a double tap creates two charges."), false);
  assert.equal(reviewPasses("There is one issue: the webhook isn't idempotent."), false);
  assert.equal(reviewPasses("Looks fine overall; one concern: the toast copy is cut off."), false);
  assert.equal(reviewPasses("I reviewed it and found nothing wrong."), true);
  assert.equal(reviewPasses("No problems found; the code reads well."), true);
  assert.equal(reviewPasses("Checked the endpoint and the tests: all good."), true);
});
