import assert from "node:assert/strict";
import test from "node:test";
import { MESH_INSTRUCTIONS, splits } from "../src/agent-mesh.js";
import { SYSTEM_NOTE } from "../src/engine/hub.js";

// Arun, 2026-10-21: "look into the coding tools using sub agents and stuff for the tasks and stuff given to them, make it smart".
// In a week of sessions Claude Code started six sub-agents and the other tools none.

test("every coding tool is told when its own sub-agents save time, and when they don't", () => {
  assert.match(SYSTEM_NOTE, /Use your own sub-agents \(Claude Code's Task tool, Codex's spawn_agent, or your tool's own\) when they save time/);
  assert.match(SYSTEM_NOTE, /Start the independent ones together, in one step/);
  assert.match(SYSTEM_NOTE, /keep the edits to yourself, unless the pieces are separate files/);
  assert.match(SYSTEM_NOTE, /Not for a small task, or for steps that wait on each other/);
  // Its sub-agents are its helpers, the session's agents its teammates, and the friday tools stay with it.
  assert.match(MESH_INSTRUCTIONS, /Your own sub-agents are helpers inside your task, in your folder; the agents here are teammates/);
  assert.match(MESH_INSTRUCTIONS, /These friday tools are yours, not your sub-agents'/);
});

test("a task is big enough to split with sub-agents when it owns several files or says a lot, never a small one", () => {
  assert.equal(splits({ owns: ["a.ts", "b.ts", "c.ts"], detail: "" }), true);
  assert.equal(splits({ owns: [], detail: "x".repeat(600) }), true);
  assert.equal(splits({ owns: ["a.ts"], detail: "Fix the typo in the header." }), false);
});
