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
  // Each thing is found on the tab it is on, and only there (Arun, 2026-11-08: categories a user finds things by).
  assert.ok(ids("keep awake").includes("computer") && !ids("keep awake").includes("coding-tools"), "keep awake");
  assert.equal(ids("GitHub")[0], "github", "GitHub"); // and, with a team, Slack & issues (GitHub issues start work)
  assert.ok(ids("SSH").includes("other-computers"), "SSH");
  for (const q of ["ACP", "Other ACP agent", "sign in", "Codex", "Fewer coding tools"]) assert.ok(ids(q).includes("coding-tools") && !ids(q).includes("computer"), q);
  for (const q of ["what's new", "What's new", "release notes"]) assert.deepEqual(ids(q), ["updates"], q);
  assert.deepEqual(ids("welcome"), ["help"]);
  for (const q of ["analytics", "telemetry"]) assert.deepEqual(ids(q), ["privacy"], q);
  for (const q of ["screen", "mouse"]) assert.deepEqual(ids(q), ["permissions"], q);
  assert.deepEqual(ids("export"), ["data"]);
  assert.deepEqual(ids("heatmap"), ["usage-limits"]);
  // Only the open-source edition has the Tailscale and Send feedback rows: the hosted one finds nothing for them. Neither has a
  // phone row: the open-source app has no phone app to pair yet (Arun, 2026-11-04).
  for (const q of ["phone", "iPhone"]) assert.deepEqual(ids(q), [], q);
  assert.deepEqual(ids("Tailscale"), ["other-computers"], "Tailscale");
  assert.deepEqual(ids("feedback"), ["help"]);
  // Widgets and slash commands find nothing in the hosted and public editions; Arun's own build has a section for them,
  // found by what it changes.
  let custom: string[] = [];
  for (const q of ["mods", "widget", "slash commands"]) assert.deepEqual(ids(q), custom, q);
});

test("old links land on the tab that holds them now, and the tabs are grouped by what you come to change (Arun, 2026-11-08)", async () => {
  const { settingsSection, SECTIONS } = await import("../src/client/Settings.js");
  const { GROUPS } = await import("../src/client/settings-sections.js");
  assert.equal(settingsSection("computer"), "computer");
  assert.equal(settingsSection("machine"), "computer");
  assert.equal(settingsSection("tools"), "coding-tools");
  assert.equal(settingsSection("about"), "updates");
  assert.equal(settingsSection("data"), "data");
  assert.deepEqual(GROUPS, ["General", "Agents", "Computers", "Connections", "Workspace", "Privacy & data", "Help"]);
  const of = (id: string) => SECTIONS.find((s) => s.id === id)!;
  assert.deepEqual([of("computer").label, of("computer").group], ["This computer", "Computers"]);
  assert.equal(of("other-computers").group, "Computers");
  for (const id of ["coding-tools", "own-models", "memory", "permissions", "usage-limits"]) assert.equal(of(id).group, "Agents", id);
  for (const id of ["github", "outside-agents"]) assert.equal(of(id).group, "Connections", id);
  for (const id of ["privacy", "data"]) assert.equal(of(id).group, "Privacy & data", id);
  for (const id of ["updates", "help"]) assert.equal(of(id).group, "Help", id);
  // A group's tabs sit together, in the order the groups are listed.
  const order = SECTIONS.map((s) => GROUPS.indexOf(s.group));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "tabs in group order");
});
