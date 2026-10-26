import assert from "node:assert/strict";
import test from "node:test";
import { firstOpen } from "../src/client/Setup.js";

// The set-up card opens one step at a time (Arun, 2026-10-26: "make the let's get you setup thing like a step form"): on the
// first step that still needs something, and on the last when everything is done, so Start is the next press.
test("the set-up card opens on the first step still to do", () => {
  assert.equal(firstOpen([{ done: true }, { done: false }, { done: false }]), 1);
  assert.equal(firstOpen([{ done: false }, { done: true }, { done: true }]), 0);
  assert.equal(firstOpen([{ done: true }, { done: true }]), 1, "all done: the last, with Start");
});
