import assert from "node:assert/strict";
import test from "node:test";
import { mathText } from "../src/client/AnswerParts.js";

/** LaTeX as coding tools write it, turned into what the maths parser reads (AnswerParts mathText). */

test("\\[ … \\] becomes an equation on its own lines and \\( … \\) inline maths", () => {
  assert.equal(mathText(String.raw`So \[ a = \tanh(z) \] and \( x_1 \) here.`), "So \n$$\na = \\tanh(z)\n$$\n and $$x_1$$ here.");
});

test("code is left as written, fenced or inline, and text without LaTeX is untouched", () => {
  const fenced = "```py\nprint(r\"\\[ x \\]\")\n```";
  assert.equal(mathText(fenced), fenced);
  assert.equal(mathText("Use `\\( x \\)` to write it."), "Use `\\( x \\)` to write it.");
  assert.equal(mathText("It costs $5 or $10."), "It costs $5 or $10.");
});

test("an equation still being written is left until it closes", () => {
  assert.equal(mathText("Then \\[ a = "), "Then \\[ a = ");
});
