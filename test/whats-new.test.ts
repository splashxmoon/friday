import assert from "node:assert/strict";
import { test } from "node:test";
import { WHATS_NEW, notesUrl, releaseOf, whatsNewDue } from "../src/client/whats-new.js";

test("What's new shows only on the first start after an update, with that version's notes", () => {
  const due = (p: Partial<Parameters<typeof whatsNewDue>[0]>) => whatsNewDue({ notes: "0.2.10", running: "0.2.10", last: "0.2.9", shown: null, knew: true, ...p });
  assert.equal(due({}), true, "updated from 0.2.9 to 0.2.10");
  assert.equal(due({ shown: "0.2.10" }), false, "already shown: never again, however often it starts");
  assert.equal(due({ last: "0.2.10" }), false, "the same version as last time: no update, nothing shown");
  assert.equal(due({ running: "0.2.11" }), false, "notes left from an older release are never shown on a newer one");
  assert.equal(due({ running: "0.2.9", last: "0.2.8" }), false, "nor newer notes on an older version");
  assert.equal(due({ last: null, knew: true }), true, "from a version that kept no record, by someone past the welcome");
  assert.equal(due({ last: null, knew: false }), false, "a fresh install: the welcome, not notes for what they just installed");
  assert.equal(due({ running: "0.2.10-mine.202611040538", last: "0.2.9-mine.202611040516" }), true, "a personal build counts by its release");
  assert.equal(due({ running: "0.2.10-mine.202611040600", last: "0.2.10-mine.202611040538" }), false, "a rebuild of the same release isn't an update");
  assert.equal(due({ running: "" }), false, "version unknown: nothing");
  assert.equal(releaseOf("v0.2.10-mine.1"), "0.2.10");
});

test("the notes fit the sheet", () => {
  assert.match(WHATS_NEW.version, /^\d+\.\d+\.\d+$/);
  assert.ok(WHATS_NEW.items.length >= 1 && WHATS_NEW.items.length <= 4);
  for (const it of WHATS_NEW.items) assert.ok(it.title.length <= 26, `"${it.title}" fits on one line in half the sheet`);
  assert.equal(notesUrl("0.2.10"), "https://github.com/splashxmoon/friday/releases/tag/v0.2.10");
});
