// A Claude Code turn that ends in an error says why in words, never its result's subtype (Arun, 2026-11-02: "Agent stopped:
// error_during_execution").
import assert from "node:assert/strict";
import test from "node:test";
import { resultError } from "../src/runner/adapters.js";

test("what it said first, then the errors it listed, then what the subtype means", () => {
  assert.equal(resultError({ subtype: "error_during_execution", result: "API Error: 529 Overloaded" }), "API Error: 529 Overloaded");
  assert.equal(resultError({ subtype: "error_during_execution", result: "", errors: ["Tool failed", " ", "Tool failed", "Stream closed"] }), "Tool failed\nStream closed");
  assert.equal(resultError({ subtype: "error_during_execution", result: "" }), "Claude Code hit an error partway through the turn and didn't say what.");
  assert.equal(resultError({ subtype: "error_max_turns" }), "Claude Code used all the turns it was allowed for this message.");
  for (const m of [{ subtype: "error_something_new" }, {}]) assert.doesNotMatch(resultError(m), /error_|_/, "a code it doesn't know isn't shown either");
});
