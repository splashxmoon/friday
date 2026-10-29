// Finding a session by what was said in it (session-search.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { flatText, searchEvents, snippetOf, termsOf, titleMatches, wordsOf } from "../src/session-search.js";
import type { SessionEvent } from "../src/types.js";

const ev = (seq: number, body: SessionEvent["body"], name = "Maya Chen"): SessionEvent => ({ seq, ts: 1_000 + seq, actor: { id: "u", name, kind: "human" } as SessionEvent["actor"], body });

test("every word, any order, newest first; only what people and agents said", () => {
  const events = [
    ev(1, { type: "instruction", text: "Fix the login page token refresh", interrupt: false }),
    ev(2, { type: "agent.message", text: "The token the login page keeps is refreshed twice.", toolCalls: [] } as never, "Claude Code"),
    ev(3, { type: "suggestion", text: "check the logout path too" }),
    ev(4, { type: "member.joined", member: { id: "x", name: "login token" } } as never),
  ];
  const hits = searchEvents(events, "token LOGIN");
  assert.deepEqual(hits.map((h) => h.seq), [2, 1], "newest first, both words, events that aren't messages skipped");
  assert.equal(hits[0]!.who, "Claude Code");
  assert.deepEqual(searchEvents(events, "logout").map((h) => h.seq), [3]);
  assert.deepEqual(searchEvents(events, "token", 1).map((h) => h.seq), [2], "at most the limit");
  assert.deepEqual(searchEvents(events, "x"), [], "one letter is no search");
});

test("a quoted phrase must appear as written; filters narrow by who, what and when; the best match comes first", () => {
  const me = { id: "me", name: "Maya Chen", kind: "human" as const };
  const bob = { id: "bob", name: "Bob", kind: "human" as const };
  const agent = { id: "a", name: "Claude Code", kind: "agent" as const };
  const at = (seq: number, actor: SessionEvent["actor"], body: SessionEvent["body"], ts = 1_000 + seq): SessionEvent => ({ seq, ts, actor, body });
  const events = [
    at(1, me, { type: "instruction", text: "the token refresh is slow on login", interrupt: false }),
    at(2, agent, { type: "agent.message", text: "Fixed the login token refresh.", toolCalls: [] } as never),
    at(3, bob, { type: "thread.opened", id: "t", path: "a.ts", line: 1, code: "", text: "token refresh here too?" } as never, 5_000),
    at(4, agent, { type: "agent.message", text: `${"words ".repeat(400)} token and refresh mentioned in passing`, toolCalls: [] } as never),
  ];
  assert.deepEqual(termsOf(`"token refresh" login`), ["token refresh", "login"]);
  assert.deepEqual(searchEvents(events, `"refresh token"`).map((h) => h.seq), [], "a phrase in the other order is not the phrase");
  assert.deepEqual(searchEvents(events, "token refresh", 3, Infinity, { from: "me", me: "me" }).map((h) => h.seq), [1]);
  assert.deepEqual(searchEvents(events, "token refresh", 3, Infinity, { from: "people", me: "me" }).map((h) => h.seq), [3]);
  assert.deepEqual(searchEvents(events, "token refresh", 9, Infinity, { kind: "answer" }).map((h) => h.seq).sort(), [2, 4]);
  assert.deepEqual(searchEvents(events, "token refresh", 9, Infinity, { since: 4_000 }).map((h) => h.seq), [], "older than the window: stops there");
  assert.equal(searchEvents(events, "token refresh", 9).at(-1)!.seq, 4, "a long message that only mentions it ranks last");
  assert.equal(titleMatches("Tidy up the Login code", "login tidy"), true);
  assert.equal(titleMatches("Tidy up", "login"), false);
});

test("the snippet centres on the match and marks it", () => {
  const long = `${"a ".repeat(100)}the session TOKEN is logged here ${"b ".repeat(100)}`;
  const { snippet, marks } = snippetOf(long, wordsOf("token logged"), 60);
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"));
  assert.deepEqual(marks.map(([a, z]) => snippet.slice(a, z)), ["TOKEN", "logged"], "every word marked, in order");
  assert.deepEqual(wordsOf("  the  the Login "), ["the", "login"]);
});

// Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL": an agent's question was never found ("Monday" found
// nothing), a table read as one run of words, and a Claude Code answer showed Friday's mark.
test("an agent's question is found, with its tool; a table reads as cells and rows", () => {
  const agent = { id: "lane", name: "Claude Code", kind: "agent" } as SessionEvent["actor"];
  const q: SessionEvent = { seq: 7, ts: 2_000, actor: agent, body: { type: "agent.question", callId: "c", question: "Should the week start on Monday or Sunday?", options: ["Monday", "Sunday"], to: "u", toName: "Maya" } as never };
  const hits = searchEvents([q], "monday", 3, Infinity, { agentTool: () => "claude" });
  assert.deepEqual(hits.map((h) => [h.seq, h.by, h.tool]), [[7, "agents", "claude"]]);
  assert.equal(flatText("Here:\n\n| Step | Who |\n|---|:-:|\n| Fix | Claude |\n| Test | Codex |\n\nThen **ship**."), "Here: — Step · Who; Fix · Claude; Test · Codex — Then ship.");
});
