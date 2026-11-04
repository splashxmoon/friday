import assert from "node:assert/strict";
import { test } from "node:test";
import { WHATS_NEW, notesUrl, whatsNewDue } from "../src/client/whats-new.js";

test("What's new shows once for each release's notes, and only to someone who used Friday before", () => {
  assert.equal(whatsNewDue("0.2.10", null, true), true, "updated from a version before the sheet existed");
  assert.equal(whatsNewDue("0.2.10", "0.2.9", true), true, "updated to a release with new notes");
  assert.equal(whatsNewDue("0.2.10", "0.2.10", true), false, "already shown");
  assert.equal(whatsNewDue("0.2.10", null, false), false, "a fresh install has the welcome instead");
});

test("the notes fit the sheet", () => {
  assert.match(WHATS_NEW.version, /^\d+\.\d+\.\d+$/);
  assert.ok(WHATS_NEW.items.length >= 1 && WHATS_NEW.items.length <= 4);
  for (const it of WHATS_NEW.items) assert.ok(it.title.length <= 26, `"${it.title}" fits on one line in half the sheet`);
  assert.equal(notesUrl("0.2.10"), "https://github.com/splashxmoon/friday/releases/tag/v0.2.10");
});
