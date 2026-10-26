// The command palette (Palette.tsx): what it reaches, and what a few letters find.
import assert from "node:assert/strict";
import test from "node:test";

const recents = ["RISKY tidy up the login code and bump the auth library", "ASK clean the build folder"].map((title, i) => ({ sid: `s${i}`, title, invite: "", role: "owner", openedAt: i }));
const base = async (team = true) => {
  const { baseActions } = await import("../src/client/Palette.js");
  return baseActions({ recents: recents as never, open: () => {}, newSession: () => {}, goto: () => {}, toggleSidebar: () => {}, showShortcuts: () => {}, search: () => {}, look: () => {}, team });
};
const labels = (gs: { items: { label: string }[] }[]) => gs.flatMap((g) => g.items.map((a) => a.label));

test("it reaches every page, search and the looks; People only with a team; no Connections page", async () => {
  const all = (await base()).map((a) => a.label);
  for (const want of ["Agent Board", "Code Review", "Automations", "Saved agents", "Usage", "Settings", "People", "Search sessions and what was said", "Use the dark look"]) assert.ok(all.includes(want), want);
  // Gone (Arun, 2026-10-22): the coding tools have their MCP servers connected in their own tools.
  assert.ok(!all.includes("Connections"));
  const solo = (await base(false)).map((a) => a.label);
  assert.ok(!solo.includes("People"));
});

test("a word, or the first letters of words, beats letters scattered through a title; groups never match", async () => {
  const { paletteGroups } = await import("../src/client/Palette.js");
  const actions = await base();
  const set = labels(paletteGroups(actions, "set"));
  assert.equal(set[0], "Settings", "not every session that holds s…e…t");
  assert.ok(set.length > 1 && set.slice(1).every((l) => l.startsWith("Settings · ")), "then its sections, and nothing else");
  assert.equal(labels(paletteGroups(actions, "cr"))[0], "Code Review", "first letters");
  assert.ok(!labels(paletteGroups(actions, "sessions")).some((l) => l.startsWith("RISKY")), "the group name 'Sessions' isn't what a row says");
  assert.ok(labels(paletteGroups(actions, "build")).includes("ASK clean the build folder"));
  assert.ok(labels(paletteGroups(actions, "rsktdy")).length > 0, "with nothing closer, the scattered kind still finds something");
  assert.equal(paletteGroups(actions, "").length > 2, true, "empty: everything, grouped");
});

test("the library's first steps are in the palette: New agent, and Invite only with a team; the Skills page is gone", async () => {
  const { baseActions } = await import("../src/client/Palette.js");
  const make = (team: boolean) =>
    baseActions({ recents: [], open: () => {}, newSession: () => {}, goto: () => {}, toggleSidebar: () => {}, showShortcuts: () => {}, team, newAgent: () => {}, invite: () => {} }).map((a) => a.label);
  for (const want of ["New agent", "Invite someone by email"]) assert.ok(make(true).includes(want), want);
  for (const gone of ["New skill", "Skills"]) assert.ok(!make(true).includes(gone), gone);
  assert.ok(!make(false).includes("Invite someone by email"));
});

test("a page intent is used once, and only by the page it is for", async () => {
  const { askPage, takeIntent } = await import("../src/client/intent.js");
  (globalThis as { dispatchEvent?: unknown }).dispatchEvent ??= () => true;
  askPage("invite");
  assert.equal(takeIntent("new-skill"), false);
  assert.equal(takeIntent("invite"), true);
  assert.equal(takeIntent("invite"), false);
});

test("every Settings section is in the palette by name, and picking one asks for that section", async () => {
  const { baseActions } = await import("../src/client/Palette.js");
  const { SECTIONS } = await import("../src/client/Settings.js");
  const asked: string[] = [];
  (globalThis as { dispatchEvent?: unknown }).dispatchEvent = (e: Event) => (asked.push(String((e as CustomEvent<{ tab?: string }>).detail?.tab)), true);
  const actions = baseActions({ recents: [], open: () => {}, newSession: () => {}, goto: () => {}, toggleSidebar: () => {}, showShortcuts: () => {}, team: true, newAgent: () => {}, invite: () => {} });
  for (const s of SECTIONS) {
    const row = actions.find((a) => a.label === `Settings · ${s.label}`);
    assert.ok(row, s.label);
    row.run();
  }
  assert.deepEqual(asked, SECTIONS.map((s) => s.id));
});
