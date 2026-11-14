// One sentence for a usage limit in Code and in Crew (the "Why Crew" plan, 2026-11-13): Code hands the task to another agent,
// Crew puts the crew mate on its backup tool, and both say "<tool> is out until <time>. <who> carried on."
import assert from "node:assert/strict";
import { test } from "node:test";
import { limitLine } from "../src/limit-words.js";

test("Code's hand-on at a limit: the tool that ran out, when it's back, and the agent that carried on", () => {
  assert.equal(limitLine({ out: "Claude Code", until: "2:10 PM", carrier: "Codex" }), "Claude Code is out until 2:10 PM. Codex carried on.");
  assert.equal(limitLine({ out: "Claude Code", until: "2:10 PM", carrier: "Codex", forWhom: " for you" }), "Claude Code is out until 2:10 PM. Codex carried on for you.");
});

test("Crew's switch to a backup: the same shape, the crew mate carrying on with its backup tool", () => {
  assert.equal(limitLine({ out: "Claude Code", until: "2:10 PM tomorrow", carrier: "Kit", with: "Codex" }), "Claude Code is out until 2:10 PM tomorrow. Kit carried on with Codex.");
});

test("no time when the limit didn't say one, and no 'with' when the carrier is the tool itself", () => {
  assert.equal(limitLine({ out: "Codex", until: null, carrier: "Claude Code", with: "Claude Code" }), "Codex is out. Claude Code carried on.");
  assert.equal(limitLine({ out: "Rex", carrier: "Gemini CLI" }), "Rex is out. Gemini CLI carried on.");
});
