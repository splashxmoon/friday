import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Crew, CrewState } from "../src/attention.js";
import { CrewLine } from "../src/client/Sidebar.js";

// A session row's second line with several agents (Arun, 2026-11-10: "instead of 3 agents done text can we have the coding tool
// icons on the right side and get rid of the text"): finished or ready, their marks at the right, what was last asked at the left
// (2026-11-16), said in words to a screen reader; any
// other case keeps its words.
const agent = (lane: string, name: string, tool: "claude" | "codex" | undefined, state: CrewState): Crew["agents"][number] => ({ lane, name, ...(tool ? { tool } : { face: 0 }), state, word: state });
const line = (agents: Crew["agents"]) => {
  (globalThis as { window?: unknown }).window ??= { dispatchEvent: () => true };
  return renderToStaticMarkup(createElement(CrewLine, { crew: { sid: "s", agents }, now: Date.now() }));
};
const three = (state: CrewState, last: CrewState = state) => [agent("a", "Claude Code", "claude", state), agent("b", "Claude Code 2", "claude", state), agent("c", "Codex", "codex", last)];

test("several agents done: a mark each at the line's end, what was last asked on its left (else how they stand), what they said in the marks' label", () => {
  const html = line(three("done"));
  // The left of the line is not left empty (Arun, 2026-11-16: "need more details and info here there is empty space on the left").
  assert.match(html, /class="sb-crew-lead truncate">3 agents · done</);
  assert.match(renderToStaticMarkup(createElement(CrewLine, { crew: { sid: "s", agents: three("done") }, now: 0, lead: "You: tidy the README" })), /class="sb-crew-lead truncate">You: tidy the README</);
  assert.match(html, /class="sb-crew sb-crew-end"/);
  assert.match(html, /role="img" aria-label="3 agents, done: Claude Code, Claude Code 2, Codex"/);
  assert.equal(html.match(/<span title="/g)?.length, 3, "a mark per agent");
  assert.doesNotMatch(html, /sb-crew-words/, "no words");
});

test("several agents ready the same, and more than five end in +N", () => {
  assert.match(line(three("idle")), /aria-label="3 agents, ready: Claude Code, Claude Code 2, Codex"/);
  assert.match(line(three("idle", "done")), /aria-label="3 agents, done: /, "one done of three still says done, as the words did");
  const seven = Array.from({ length: 7 }, (_, i) => agent(`l${i}`, `Codex ${i}`, "codex", "done"));
  const html = line(seven);
  assert.equal(html.match(/<span title="/g)?.length, 5);
  assert.match(html, /class="sb-crew-more">\+2</);
  assert.match(line([agent("main", "Friday Code", undefined, "done"), agent("c", "Codex", "codex", "done")]), /class="mascot still agent-face"/, "Friday's own agent wears its face");
});

test("the other cases keep their words: one agent, several working, one failed, one held", () => {
  assert.match(line([agent("a", "Claude Code", "claude", "done")]), /sb-crew-words/);
  assert.doesNotMatch(line([agent("a", "Claude Code", "claude", "done")]), /sb-crew-end/);
  const working = line(three("working"));
  assert.match(working, />working</);
  assert.match(working, /aria-label="3 working: /);
  assert.doesNotMatch(working, /sb-crew-end/);
  assert.match(working, /class="sb-crew sb-crew-split"/, "several at work: the word on the left, their marks at the line's right as when they finish");
  assert.doesNotMatch(line([...three("working"), agent("d", "Codex 2", "codex", "failed")]), /sb-crew-split/, "a line about the one that failed keeps the marks before it");
  assert.doesNotMatch(line(three("done", "failed")), /sb-crew-end/);
  assert.doesNotMatch(line(three("done", "waiting")), /sb-crew-end/);
  assert.doesNotMatch(line(three("done", "limited")), /sb-crew-end/);
});
