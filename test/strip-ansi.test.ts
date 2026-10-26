import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi } from "../src/runner/preview.js";

test("a terminal's colour and cursor codes come out, and the text is what a person would have read", () => {
  const E = String.fromCharCode(27);
  assert.equal(stripAnsi(`${E}[32m${E}[1mVITE${E}[22m v8.3.0${E}[39m  ready in ${E}[1m344${E}[22m ms`), "VITE v8.3.0  ready in 344 ms");
  assert.equal(stripAnsi(`  ${E}[32m➜${E}[39m  ${E}[1mLocal${E}[22m:   ${E}[36mhttp://localhost:${E}[1m5174${E}[22m/${E}[39m`), "  ➜  Local:   http://localhost:5174/");
  assert.equal(stripAnsi(`plain text${String.fromCharCode(13)}`), "plain text");
  assert.equal(stripAnsi(""), "");
});
