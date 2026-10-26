import assert from "node:assert/strict";
import { test } from "node:test";
import { sizeOf } from "../src/client/Workbench.js";

test("a panel's width is one of four sizes, with the edges where the layouts change", () => {
  assert.equal(sizeOf(320), "xs");
  assert.equal(sizeOf(379), "xs");
  assert.equal(sizeOf(380), "sm");
  assert.equal(sizeOf(519), "sm");
  assert.equal(sizeOf(520), "md");
  assert.equal(sizeOf(759), "md");
  assert.equal(sizeOf(760), "lg");
  assert.equal(sizeOf(980), "lg");
});
