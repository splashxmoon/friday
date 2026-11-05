// A coding agent's turn shows its thinking as it streams (Arun, 2026-11-04: "show the thinking process because right now it
// just looks stuck"): Claude Code is asked for its thinking as words, its thinking deltas reach the room as thinking, the
// folded line names the newest sentence, and the forecast under a working turn is said plainly or not at all.
import assert from "node:assert/strict";
import test from "node:test";
import { claude } from "../src/runner/adapters.js";
import { refusedFlag } from "../src/runner/runner.js";
import { latestThought } from "../src/client/Response.js";
import { forecastWords } from "../src/client/runForecast.js";
import type { TurnSpec } from "../src/runner/adapters.js";

const base = { prompt: "hi", system: "", mode: "full" } as unknown as TurnSpec;

test("Claude Code is asked for its thinking as summarized words, and left without the flag once a version refuses it", () => {
  const args = claude.args(base);
  const at = args.indexOf("--thinking-display");
  assert.ok(at > 0, "asked for");
  assert.equal(args[at + 1], "summarized");
  assert.ok(args.includes("--include-partial-messages"), "deltas, not only whole blocks");
  assert.ok(claude.optional?.includes("--thinking-display"), "an older version refusing it runs the turn again without");
  assert.equal(refusedFlag("error: unknown option '--thinking-display'", ["--thinking-display"]), "--thinking-display");
  assert.equal(refusedFlag("error: option '--thinking-display <display>' argument 'summarized' is invalid. Allowed choices are omitted.", ["--thinking-display"]), "--thinking-display");
  const without = claude.args({ ...base, skip: ["--thinking-display"] } as TurnSpec);
  assert.ok(!without.includes("--thinking-display") && !without.includes("summarized"), "flag and value both left off");
});

test("its thinking streams as thinking, its words as words, and a withheld thought is nothing", () => {
  const parse = claude.parser(base);
  const ev = (event: unknown) => JSON.stringify({ type: "stream_event", event, parent_tool_use_id: null });
  assert.deepEqual(parse(ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look" } })), [{ kind: "delta", text: "Let me look", channel: "reasoning" }]);
  assert.deepEqual(parse(ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "Eq" } })), []);
  assert.deepEqual(parse(ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done" } })), [{ kind: "delta", text: "Done", channel: "text" }]);
  // The block whole, as its own message: kept as the turn's reasoning (the log already keeps it, capped).
  assert.deepEqual(parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Let me look.", signature: "Eq" }] }, parent_tool_use_id: null })), [{ kind: "message", text: "", toolCalls: [], reasoning: "Let me look." }]);
  // Withheld (redacted, or its display omitted): no words, so no message, and the reply says what stage it is at instead.
  assert.deepEqual(parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "redacted_thinking", data: "Em" }] }, parent_tool_use_id: null })), []);
  assert.deepEqual(parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "Eq" }] }, parent_tool_use_id: null })), []);
});

test("the folded thinking line shows the newest sentence, as far as it is written", () => {
  assert.equal(latestThought(""), "");
  assert.equal(latestThought("The person wants the timeout looked at. Before changing anything I should find"), "Before changing anything I should find");
  // A sentence just begun brings the one before it, rather than a lone word.
  assert.equal(latestThought("The README confirms the layout. The"), "The README confirms the layout. The");
  // Line breaks and runs of spaces are one space; a long sentence keeps its newest words.
  assert.equal(latestThought("First.\n\nSecond   one\nhere"), "First. Second one here");
  const long = latestThought(`Start ${"word ".repeat(60)}end`, 40);
  assert.ok(long.startsWith("…") && long.endsWith("end") && long.length <= 41, long);
});

test("the forecast under a working turn is said plainly from real runs, or not at all", () => {
  const now = 1_000_000_000;
  assert.equal(forecastWords({ ms: 9 * 60_000, tokens: null, runs: 0, basis: "typical" }, now, now), "", "nothing measured here: no guess");
  assert.equal(forecastWords({ ms: 8 * 60_000, tokens: null, runs: 1, basis: "workspace" }, now, now), "", "one run is mostly the guess");
  assert.equal(forecastWords({ ms: 3 * 60_000, tokens: null, runs: 5, basis: "workspace" }, now, now), "", "and five still lean on it");
  assert.equal(forecastWords({ ms: 6 * 60_000, tokens: null, runs: 12, basis: "repo" }, now - 60_000, now), "~5 min left");
  // Past it: what it usually takes, never a dangling "longer than runs like it".
  assert.equal(forecastWords({ ms: 2 * 60_000, tokens: null, runs: 12, basis: "repo" }, now - 3 * 60_000, now), "usually ~2 min");
});
