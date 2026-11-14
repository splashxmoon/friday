import assert from "node:assert/strict";
import test from "node:test";
import { onlyAcknowledges } from "../src/agent-mesh.js";

test("an agent's message that only acknowledges is told apart from one that says something", () => {
  for (const t of ["Got it, thanks!", "Sounds good 👍", "ok", "Thanks you!", "Will do.", "Perfect, thank you so much!", "LGTM", "Noted. Thanks!", "🙏"]) assert.equal(onlyAcknowledges(t), true, t);
  for (const t of [
    "Got it. I'll take cart.ts, you keep the API.",
    "Thanks, but the test still fails on CI: the price mock isn't reset.",
    "Done: totals are computed on the server, 3 files, tests pass.",
    "ok so which branch do you want me on?",
    "Sounds good, merging after the review.",
  ])
    assert.equal(onlyAcknowledges(t), false, t);
});
