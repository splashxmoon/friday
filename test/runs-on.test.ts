// "Runs on", the line above the new-session box (Computers.tsx RunsOn; Arun, 2026-11-07: "Move the machine selector to above
// the input chat"): each computer's line in its menu says whether it can take work now, and with which coding tools.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./fake-dom.js";

const { computerLine, lastSeen } = await import("../src/client/Computers.js");
const tools = [
  { tool: "claude", name: "Claude Code", loggedIn: true },
  { tool: "codex", name: "Codex", loggedIn: true },
  { tool: "cursor", name: "Cursor", loggedIn: false },
];

test("a connected computer says the coding tools signed in there", () => {
  assert.equal(computerLine({ connected: true, seen: Date.now(), tools }, "0.2.17"), "Claude Code, Codex");
  assert.equal(computerLine({ connected: true, seen: Date.now(), tools: [] }), "No coding tool signed in");
});

test("another Friday there than here is said after its tools", () => {
  assert.equal(computerLine({ connected: true, seen: Date.now(), tools, version: "0.2.16" }, "0.2.17"), "Claude Code, Codex · Friday 0.2.16 there");
});

test("one not connected says since when, and a problem only pairing again fixes says that instead", () => {
  assert.equal(computerLine({ connected: false, seen: Date.now() - 2 * 3600_000, tools }), "Not connected · last seen 2h ago");
  const problem = "It made a new certificate: pair it again.";
  assert.equal(computerLine({ connected: false, seen: Date.now(), tools, problem }), problem);
});

test("last seen reads as a person would say it", () => {
  assert.equal(lastSeen(Date.now()), "just now");
  assert.equal(lastSeen(Date.now() - 5 * 60_000), "5m ago");
  assert.match(lastSeen(Date.now() - 30 * 86400_000), /^on \w+ \d+$/);
});
