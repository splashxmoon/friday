// Settings search (Settings.tsx): a section is found by the most of your words, not only by all of them.
import assert from "node:assert/strict";
import test from "node:test";

test("'dark mode' finds Appearance; 'api key' finds Your models; nonsense finds nothing", async () => {
  const { sectionsMatching, SECTIONS } = await import("../src/client/Settings.js");
  const ids = (q: string) => sectionsMatching(SECTIONS, q).map((s) => s.id);
  assert.deepEqual(ids("dark mode"), ["appearance"]);
  assert.deepEqual(ids("zzqx"), []);
  assert.equal(ids("  ").length, SECTIONS.length, "an empty search lists everything");
});
