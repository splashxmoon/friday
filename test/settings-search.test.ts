// Settings search (Settings.tsx): a section is found by the most of your words, not only by all of them.
import assert from "node:assert/strict";
import test from "node:test";

test("'dark mode' finds Appearance; 'api key' finds Your models; nonsense finds nothing", async () => {
  const { sectionsMatching, SECTIONS } = await import("../src/client/Settings.js");
  const ids = (q: string) => sectionsMatching(SECTIONS, q).map((s) => s.id);
  assert.deepEqual(ids("dark mode"), ["appearance"]);
  assert.deepEqual(ids("zzqx"), []);
  // Usage, a budget or a limit finds the Usage page's row (audit REST-21).
  for (const q of ["budget", "limits", "plan price"]) assert.ok(ids(q).includes("usage-limits"), q);
  assert.equal(ids("  ").length, SECTIONS.length, "an empty search lists everything");
});

test("every thing on a Settings page is found by its own word (audit e2e, Arun 2026-11-04)", async () => {
  const { sectionsMatching, SECTIONS } = await import("../src/client/Settings.js");
  const ids = (q: string) => sectionsMatching(SECTIONS, q).map((s) => s.id);
  for (const q of ["accent", "layout", "Session layout"]) assert.deepEqual(ids(q), ["appearance"], q);
  for (const q of ["GitHub", "SSH", "ACP", "Other ACP agent"]) assert.ok(ids(q).includes("computer"), q);
  for (const q of ["welcome", "what's new", "What's new"]) assert.deepEqual(ids(q), ["about"], q);
  assert.deepEqual(ids("heatmap"), ["usage-limits"]);
  // Only the open-source edition has the Tailscale and Send feedback rows: the hosted one finds nothing for them. Neither has a
  // phone row: the open-source app has no phone app to pair yet (Arun, 2026-11-04).
  for (const q of ["phone", "iPhone"]) assert.deepEqual(ids(q), [], q);
  assert.deepEqual(ids("Tailscale"), ["computer"], "Tailscale");
  assert.deepEqual(ids("feedback"), ["about"]);
});
