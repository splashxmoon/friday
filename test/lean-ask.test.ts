// A lean ask (Arun, 2026-11-25: "we need to ensure Friday is optimized for cost while maintaining performance"): Friday's own small
// jobs (a lesson from a run, a suggested answer, a plan) are answered from their prompt alone, without the coding tool's whole kit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTERS, refusedFlag, type TurnSpec } from "../src/runner/adapters.js";

const spec = (o: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: "p", resumeId: null, mode: "plan", system: "Read the run and list its lessons.", ephemeral: true, ...o }) as TurnSpec;

test("Claude Code, lean: no tools, none of the person's MCP servers, and Friday's words as its whole system prompt", () => {
  const args = ADAPTERS.claude.args(spec({ lean: true }));
  const at = args.indexOf("--tools");
  assert.ok(at >= 0 && args[at + 1] === "", "no built-in tools");
  assert.ok(args.includes("--strict-mcp-config"), "no MCP servers of the person's");
  assert.equal(args[args.indexOf("--system-prompt") + 1], "Read the run and list its lessons.");
  assert.ok(!args.includes("--append-system-prompt"), "instead of appended to Claude Code's own");
});

test("not lean, as before: Claude Code's own system prompt with Friday's appended, its tools and MCP servers", () => {
  const args = ADAPTERS.claude.args(spec());
  assert.ok(!args.includes("--tools") && !args.includes("--strict-mcp-config") && !args.includes("--system-prompt"));
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "Read the run and list its lessons.");
});

test("an older Claude Code that refuses a lean flag is asked again without it, one at a time; without --system-prompt Friday's words are appended", () => {
  for (const flag of ["--tools", "--strict-mcp-config", "--system-prompt"]) assert.ok(ADAPTERS.claude.optional?.includes(flag), flag);
  assert.equal(refusedFlag("error: unknown option '--strict-mcp-config'", ADAPTERS.claude.optional ?? []), "--strict-mcp-config");
  const older = ADAPTERS.claude.args(spec({ lean: true, skip: ["--tools", "--system-prompt"] }));
  assert.ok(!older.includes("--tools") && !older.includes("--system-prompt"));
  assert.equal(older[older.indexOf("--append-system-prompt") + 1], "Read the run and list its lessons.", "its instructions still reach it");
  assert.ok(older.includes("--strict-mcp-config"));
});
