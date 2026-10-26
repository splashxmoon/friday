import assert from "node:assert/strict";
import test from "node:test";
import { runMood } from "../src/client/Mascot.js";

test("the mascot's face follows how a run is going", () => {
  assert.equal(runMood({ active: true }), "working");
  assert.equal(runMood({ active: false, outcome: "waiting" }), "asking");
  assert.equal(runMood({ active: false, outcome: "error" }), "worried");
  assert.equal(runMood({ active: false, outcome: "done", failing: 1 }), "worried", "a command still failing is not a happy ending");
  assert.equal(runMood({ active: false, outcome: "done" }), "happy");
  assert.equal(runMood({ active: false }), "idle", "a paused or interrupted run");
});
