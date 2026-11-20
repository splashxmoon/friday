import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSummary, fixErrorsText, pagesWord } from "../src/client/ide/preview-check-text.js";

test("what a finished check says", () => {
  assert.deepEqual(checkSummary([{ errors: [], consoleChecked: true }]), { text: "No console errors", tone: "ok" });
  assert.deepEqual(checkSummary([{ errors: ["a"], consoleChecked: true }, { errors: ["b", "c"], consoleChecked: true }]), { text: "3 console errors", tone: "bad" });
  assert.deepEqual(checkSummary([{ errors: ["a"], consoleChecked: true }]), { text: "1 console error", tone: "bad" });
  // An older desktop app takes pictures but can't read the console: never "no errors" then.
  assert.deepEqual(checkSummary([{ errors: [], consoleChecked: false }]), { text: "Console not read", tone: "none" });
  assert.equal(pagesWord(1), "1 page");
  assert.equal(pagesWord(3), "3 pages");
});

test("Fix with Friday names each page and its errors", () => {
  const t = fixErrorsText([{ path: "/about", errors: ["TypeError: x"] }, { path: "/", errors: [] }, { path: "/pricing", errors: ["a", "b"] }]);
  assert.match(t, /console logged errors/);
  assert.match(t, /\/about\n {2}- TypeError: x/);
  assert.match(t, /\/pricing\n {2}- a\n {2}- b/);
  assert.ok(!/^\/$/m.test(t), "a page with no errors isn't listed");
});

test("a page that couldn't be looked at is not a console error, and not a clean console", () => {
  assert.deepEqual(checkSummary([{ errors: [], consoleChecked: false, failed: "The screenshot couldn't be taken." }]), { text: "Couldn't look at the page", tone: "none" });
  assert.deepEqual(checkSummary([{ errors: [], consoleChecked: true }, { errors: [], consoleChecked: false, failed: "x" }]), { text: "1 of 2 pages couldn't be looked at", tone: "none" });
  assert.deepEqual(checkSummary([{ errors: ["a"], consoleChecked: true }, { errors: [], consoleChecked: false, failed: "x" }]), { text: "1 console error", tone: "bad" });
});
