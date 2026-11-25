// Pages that load in the shape of what's coming and keep their times current (spec 13, Wave 3 F; Arun, 2026-11-24: "Go all out
// and fix these problems"): the placeholders for a file and a folder, the words a stamp is said in, and Code Review's Push & open
// PR handed to a session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { askCard, takeCardAsk } from "../src/client/card-ask.js";
import { SkeletonCode, SkeletonTree, agoWords } from "../src/client/ui.js";

test("a stamp reads as words after its verb: just now, 4m ago, and a date as itself, never \"now ago\" or \"Nov 3 ago\"", () => {
  const now = Date.now();
  assert.equal(agoWords(now - 10_000), "just now");
  assert.equal(agoWords(now - 4 * 60_000), "4m ago");
  assert.equal(agoWords(now - 3 * 3_600_000), "3h ago");
  assert.equal(agoWords(now - 2 * 86_400_000), "2d ago");
  const old = now - 30 * 86_400_000;
  assert.equal(agoWords(old), new Date(old).toLocaleDateString([], { month: "short", day: "numeric" }));
  assert.doesNotMatch(agoWords(old), /ago/);
});

test("a file being read is lines of code in grey, the same lines each time; said to a screen reader only when asked to", () => {
  const a = renderToStaticMarkup(createElement(SkeletonCode, { lines: 12 }));
  assert.equal(a, renderToStaticMarkup(createElement(SkeletonCode, { lines: 12 })), "drawn again, it doesn't jump");
  assert.equal(a.match(/class="sk-code-line"/g)?.length, 12);
  assert.match(a, /aria-hidden/);
  assert.doesNotMatch(a, /role="status"/);
  assert.match(a, /sk-code-ind-[123]/, "some lines are indented, as code is");
  const said = renderToStaticMarkup(createElement(SkeletonCode, { lines: 3, label: "Reading app.ts" }));
  assert.match(said, /role="status"/);
  assert.match(said, /aria-label="Reading app.ts"/);
});

test("a folder being read is rows of the tree, some inside a folder", () => {
  const t = renderToStaticMarkup(createElement(SkeletonTree, { rows: 9, label: "Reading the folder" }));
  assert.equal(t.match(/class="sk-tree-row"/g)?.length, 9);
  assert.match(t, /padding-left:8px/);
  assert.match(t, /padding-left:22px/, "one level in");
  assert.match(t, /aria-label="Reading the folder"/);
});

test("Push & open PR is asked of the session's own lane once: the commit dialog takes it, opened at Push and open PR", () => {
  // Node has an EventTarget but no window: the ask is announced on the page's, here a stand-in that hears it.
  const heard: string[] = [];
  const g = globalThis as { dispatchEvent?: (e: Event) => boolean };
  const was = g.dispatchEvent;
  g.dispatchEvent = (e: Event) => (heard.push(e.type), true);
  try {
    askCard("s1", "main", "pr");
  } finally {
    g.dispatchEvent = was;
  }
  assert.deepEqual(heard, ["friday:card-ask"]);
  assert.equal(takeCardAsk("s1", "other"), null, "another lane doesn't take it");
  assert.equal(takeCardAsk("s2", "main"), null, "nor another session");
  assert.equal(takeCardAsk("s1", "main"), "pr");
  assert.equal(takeCardAsk("s1", "main"), null, "taken, it is gone");
});
