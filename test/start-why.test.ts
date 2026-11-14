import assert from "node:assert/strict";
import test from "node:test";
import { startWhy } from "../src/app.js";

// Why a teammate's coding tool didn't start, said on its row (Crew overhaul 1A; Fable review of the crew port, 2026-11-11).
test("a tool that isn't there reads as not installed, never as signed out because its message says to log in after installing", () => {
  assert.equal(startWhy({ tool: "codex" }, "Couldn't find Codex on this machine. Install it and log in, then try again."), "Codex isn't installed on this computer. Install it from Settings › Coding tools.");
  assert.equal(startWhy({ tool: "claude" }, "spawn claude ENOENT"), "Claude Code isn't installed on this computer. Install it from Settings › Coding tools.");
  assert.equal(startWhy({ tool: "claude" }, "Not logged in · Please run /login"), "Claude Code isn't signed in on this computer. Sign in from Settings › Coding tools.");
  assert.equal(startWhy({ tool: "codex" }, "401 Unauthorized"), "Codex isn't signed in on this computer. Sign in from Settings › Coding tools.");
  // Neither: "model not found" is no missing tool, and "the login shell" no sign-in.
  assert.match(startWhy({ tool: "codex" }, "model gpt-9 not found"), /^Codex didn't start/);
  assert.match(startWhy({ tool: "codex" }, "the login shell exited 2"), /^Codex didn't start/);
});
