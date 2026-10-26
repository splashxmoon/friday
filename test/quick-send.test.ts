import assert from "node:assert/strict";
import test from "node:test";
import { quickText, quickTitle } from "../src/client/quick-send.js";

test("Quick prompt: a session is named by the words, cut to fit; a snapshot alone still says what to do with it", () => {
  assert.equal(quickTitle("Fix the  login\nflash"), "Fix the login flash");
  assert.equal(quickTitle("x".repeat(80)).length, 60);
  assert.equal(quickTitle("   "), "Quick prompt");
  assert.equal(quickText({ text: "  do it  " }), "do it");
  assert.match(quickText({ text: "", snapshot: { data: "", mimeType: "image/png", width: 1, height: 1 } }), /screenshot of my screen/);
  assert.equal(quickText({ text: "" }), "");
});
