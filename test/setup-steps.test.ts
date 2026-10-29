import assert from "node:assert/strict";
import test from "node:test";
import { becameDone, firstOpen } from "../src/client/Setup.js";

// The set-up card opens one step at a time (Arun, 2026-10-26: "make the let's get you setup thing like a step form"): on the
// first step that still needs something, and on the last when everything is done, so Start is the next press.
test("the set-up card opens on the first step still to do", () => {
  assert.equal(firstOpen([{ done: true }, { done: false }, { done: false }]), 1);
  assert.equal(firstOpen([{ done: false }, { done: true }, { done: true }]), 0);
  assert.equal(firstOpen([{ done: true }, { done: true }]), 1, "all done: the last, with Start");
});

// Back to a step already done is not that step coming true, so the card doesn't move on by itself (Arun, 2026-10-28: "TEST
// EVERYTHING… EVERY INTERACTION, EVERY VISUAL"; Back from GitHub bounced forward again after 0.9 s).
test("only the step showing coming true moves the card on", () => {
  assert.equal(becameDone({ id: "tools", done: false }, { id: "tools", done: true }), true, "a sign-in finishing");
  assert.equal(becameDone({ id: "github", done: false }, { id: "tools", done: true }), false, "Back to a done step");
  assert.equal(becameDone({ id: "tools", done: true }, { id: "tools", done: true }), false);
  assert.equal(becameDone({ id: "tools", done: true }, { id: "tools", done: false }), false);
});
