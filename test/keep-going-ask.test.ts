// A teammate that ends by asking whether to go on is told to carry on (keep-going.ts asksToGoOn; after OpenBot's continuation
// check, 2026-11-15); a question about something that leaves the computer stays the person's.
import assert from "node:assert/strict";
import test from "node:test";
import { asksToGoOn } from "../src/keep-going.js";

test("asking whether to go on is no question to stop for; asking to deploy, send or delete is", () => {
  for (const t of ["Shall I continue?", "The first three are done. Want me to proceed with the rest?", "Should I go ahead and finish up?", "Would you like me to keep going?"]) assert.ok(asksToGoOn(t), t);
  for (const t of ["Shall I deploy it?", "Want me to push the branch and continue?", "Should I send the email to Ana?", "Which of the two names do you prefer?", "Done. Anything else?"]) assert.ok(!asksToGoOn(t), t);
});
