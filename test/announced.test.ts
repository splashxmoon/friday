import assert from "node:assert/strict";
import test from "node:test";
import { announcesAction } from "../src/agent/announced.js";

test("a reply that ends on what it is about to do is recognised, so the run can be told to go on", () => {
  for (const t of [
    "Let me look at the evaluation files and the server-side code to understand the full picture.",
    "I'll start by understanding the codebase structure and then dive into the key files.",
    "The gate is in place. Now I'll wire it into the loader.",
    "Next, let me run the tests.",
    "Here is what I found so far:",
    "I've read the config.\n\nI'm going to change the port now.",
  ]) assert.equal(announcesAction(t), true, t);
});

test("an answer, a question, or a sign-off is let through", () => {
  for (const t of [
    "",
    "The port was 8080 and is now 9090. Tests pass.",
    "Should I change the port to 9090 or leave it?",
    "Done. Let me know if you want anything else.",
    "That is everything. I'll leave it there.",
    "I'll be happy to help with the next one.",
    "I changed the loader. I'll note the gate stays as it was.\n\nAll 12 tests pass.",
  ]) assert.equal(announcesAction(t), false, t);
});
