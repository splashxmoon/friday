import assert from "node:assert/strict";
import test from "node:test";
import { systemPrompt } from "../src/agent/prompt.js";
import { catalogBriefs } from "../src/skill-catalog.js";
import type { AgentSnapshot } from "../src/types.js";

const agent = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  id: "a1",
  name: "Helper",
  icon: "agent",
  color: "blue",
  instructions: "Be useful.",
  tools: { webSearch: true, askHuman: true, connections: "all" },
  version: 1,
  ownerName: "Arun",
  ...over,
});

/**
 * Every session is a coding session, and the deliverable is the code itself.
 * The prompt is the only thing enforcing that.
 */
test("the deliverable is the code, in the reply", () => {
  const p = systemPrompt("A session");
  assert.match(p, /This is a coding session/);
  assert.match(p, /write code, not to write about code/);
  assert.match(p, /Answer with the code itself/);
  assert.match(p, /Never produce briefs, reports, plans-as-documents or decks here/);
  assert.ok(!/Answer in the conversation by default/.test(p), "the work-session prompt is gone");
  assert.ok(!/write_section|```chart/.test(p), "and so are artifacts, decks and charts");
});




/**
 * Without a date the model answers from its training cutoff and treats a stale
 * world as current. This is the only thing telling it otherwise.
 */
test("the agent is told today's date", () => {
  const p = systemPrompt("A session");
  const year = String(new Date().getUTCFullYear());
  assert.match(p, /Today is /);
  assert.ok(p.includes(year), `the prompt states the current year (${year})`);
  assert.match(p, /Search the web for it rather than answering from memory/);
});

/**
 * Friday's own agent knows the catalog.
 *
 * A session's agent is only as good as the instructions somebody brings it.
 * The catalog is how: it recognises the job and reads the brief for it. The
 * coding briefs come first, so the menu opens on the likely jobs. A custom
 * agent is the opposite: it gets only what its owner picked.
 */
test("Friday's agent carries the catalog, coding briefs first", () => {
  const briefs = catalogBriefs();
  assert.ok(briefs.length >= 10, "the catalog, not a slice of it");
  assert.equal(new Set(briefs.map((s) => s.id)).size, briefs.length, "no brief listed twice");
  assert.ok(!briefs.some((b) => /competitor|literature|meeting notes/i.test(b.name)), "the work-session briefs are gone");

  const p = systemPrompt("A session", null, undefined, briefs);
  assert.match(p, /You have skills/);
  assert.match(p, /Review a diff — /, "the menu is names and triggers");
  assert.ok(!p.includes("## When to use"), "not the briefs themselves — those arrive through use_skill");
  assert.match(p, /call use_skill with its name/);
  assert.match(p, /Nothing here obliges you to use one/, "most messages are just messages");
});

test("every prompt says how to use tools, and guards against the overcorrection", () => {
  for (const p of [systemPrompt("A session"), systemPrompt("A session"), systemPrompt("A session", agent({}))]) {
    assert.match(p, /How to use tools:/);
    assert.match(p, /what you would do differently depending on the answer/, "the test a call has to pass");
    assert.match(p, /Look in what you already have first/, "context before calls");
    assert.match(p, /never more than twice/, "a failing call is not retried forever");
    assert.match(p, /Stop when the instruction is done/);
    // The rule is about redundant calls, not about guessing instead of looking.
    assert.match(p, /None of this means guessing/);
  }
});

/**
 * The prompt must describe the tools the run actually has.
 *
 * Found on production: a work session with web search off still told the agent
 * to "search the web for it", so it called a tool that wasn't there — and then
 * invented three more names and called those, fifteen failures in one run.
 */
test("a session without web search is told so, and told what it does have", () => {
  const withSearch = systemPrompt("A session", null, undefined, [], ["web_search", "fetch_url", "remember"]);
  assert.match(withSearch, /Search the web for it rather than answering from memory/);

  const without = systemPrompt("A session", null, undefined, [], ["remember", "ask_human"]);
  assert.match(without, /no web access in this session/);
  assert.ok(!/Search the web for it rather than answering/.test(without), "it must not be told to use a tool it hasn't got");
  assert.match(without, /don't reach for a search tool, because there isn't one/);

  // And the list itself, so a model has no reason to guess at names.
  assert.match(without, /The tools you have in this session, and there are no others: remember, ask_human/);
  assert.match(without, /Calling anything else fails/);

  // Fetch without search is its own case: no searching, but a URL still reads.
  const fetchOnly = systemPrompt("A session", null, undefined, [], ["fetch_url"]);
  assert.match(fetchOnly, /read a page you have the URL of with fetch_url/);
});






test("a custom agent's prompt carries its instructions and nothing left over from the code that writes it", () => {
  const agent = { id: "a1", name: "Reviewer", icon: "eye", color: "blue", instructions: "Review for security first.", tools: {}, version: 1, ownerName: "Ada" } as unknown as Parameters<typeof systemPrompt>[1];
  const p = systemPrompt("A session", agent);
  assert.match(p, /running as "Reviewer", a custom agent set up by Ada/);
  assert.match(p, /<agent_instructions>\nReview for security first\./);
  assert.ok(!/task at hand\.\s+: ""/.test(p) && !/^\s*}\s*$/m.test(p.split("<agent_instructions>")[0]!.slice(-80)), "no stray expression between the intro and the instructions");
});
