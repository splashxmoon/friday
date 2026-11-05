// Quoting in a session (Activity.tsx QuoteSelection, Composer; team-room.ts): what a selection quotes, and how quotes go and come back.
import assert from "node:assert/strict";
import test from "node:test";
import { selectedText, splitQuote, splitQuotes, withQuotes } from "../src/client/team-room.js";

test("a selection across a file chip reads as one line, not three (Arun, 2026-11-04)", () => {
  const li = {};
  // "Update", the chip's path (a block inside an inline-flex chip: its block is the list item), " with the new numbers."
  assert.equal(selectedText([{ text: "Update ", block: li }, { text: "README.md", block: li }, { text: " with the new numbers.", block: li }]), "Update README.md with the new numbers.");
});

test("a new block is a new line; Markdown's source spaces are one space; code keeps its own", () => {
  const a = {}, b = {}, pre = {};
  assert.equal(
    selectedText([
      { text: "Retrain:", block: a },
      { text: "\n  run the full sweep  once more.", block: a },
      { text: "  Ship behind a flag", block: b },
      { text: "def pick(r):\n    return r", block: pre, pre: true },
    ]),
    "Retrain: run the full sweep once more.\nShip behind a flag\ndef pick(r):\n    return r",
  );
  assert.equal(selectedText([{ text: "  ", block: a }]), "");
  assert.equal(selectedText([{ text: "one", block: a }, { text: " ", block: a }, { text: " two ", block: a }]), "one two");
});

test("several quotes go as a block each before the words, and come back as they went", () => {
  const sent = withQuotes(["recall by network", "first line\nsecond line"], "  Rename it please ");
  assert.equal(sent, "> recall by network\n\n> first line\n> second line\n\nRename it please");
  assert.deepEqual(splitQuotes(sent), { quotes: ["recall by network", "first line\nsecond line"], rest: "Rename it please" });
  // The first quote alone, as the crew's room draws it (MentionText), with the second still a quote in the rest.
  assert.deepEqual(splitQuote(sent), { quote: "recall by network", rest: "> first line\n> second line\n\nRename it please" });
  assert.equal(withQuotes([], "just words"), "just words");
  assert.deepEqual(splitQuotes("no quote > here"), { quotes: [], rest: "no quote > here" });
});
