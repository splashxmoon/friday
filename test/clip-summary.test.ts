import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFiles, changeSummary, firstWords, plainWords, SUMMARY_MAX } from "../src/clip-summary.js";
import type { SessionEvent } from "../src/types.js";

const ev = (seq: number, text: string, o: Partial<SessionEvent> = {}): SessionEvent =>
  ({ seq, ts: seq, actor: { id: "a", name: "Claude Code", kind: "agent" }, body: { type: "agent.message", text }, ...o }) as SessionEvent;

test("plainWords drops markdown, keeps the words", () => {
  assert.equal(plainWords("## Done\n- I changed **the heading** in `index.html`\n- see [the page](http://x)"), "Done I changed the heading in index.html see the page");
  assert.equal(plainWords("Before\n```js\nconst a = 1\n```\nafter"), "Before after");
});

test("firstWords: the first paragraph with words, cut at a sentence end", () => {
  assert.equal(firstWords("```\ncode\n```\n\nI moved the pricing cards into a grid. They stack on phones.\n\nNotes follow."), "I moved the pricing cards into a grid. They stack on phones.");
  const long = `${"The checkout button now waits for the payment to confirm before it moves on. ".repeat(6)}`;
  const cut = firstWords(long);
  assert.ok(cut.length <= SUMMARY_MAX && cut.endsWith("."));
  const words = firstWords("word ".repeat(100));
  assert.ok(words.endsWith("…") && words.length <= SUMMARY_MAX + 1);
});

test("changeSummary: the lane's last agent message with words, up to the clip's moment", () => {
  const events = [
    ev(1, "Reading the code first."),
    ev(2, "Done: I changed the heading in index.html and added a line under it."),
    ev(3, "Something in another lane.", { lane: "l2" }),
    ev(4, "", {}),
    { ...ev(5, "A person typing"), actor: { id: "p", name: "Arun", kind: "human" } } as SessionEvent,
    ev(6, "Later words, after the clip."),
  ];
  assert.equal(changeSummary(events, "main", 5), "Done: I changed the heading in index.html and added a line under it.");
  assert.equal(changeSummary(events, "l2"), "Something in another lane.");
  assert.equal(changeSummary(events, "l3"), "");
});

test("changedFiles: each path once, at most six", () => {
  assert.deepEqual(changedFiles([{ path: "a.ts" }, { path: "a.ts" }, { path: "b.css" }]), ["a.ts", "b.css"]);
  assert.equal(changedFiles(Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts` }))).length, 6);
});
