// A long answer streams as its finished pieces plus the part still being written: the pieces are cut only where a block of
// the whole answer ends (never inside a code fence, a list or a table), and drawn together they are the whole answer.
import "./fake-dom.js";
import assert from "node:assert/strict";
import test from "node:test";

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { parseMarkdownIntoBlocks } = await import("streamdown");
const { MessageResponse } = await import("../src/client/components/ai-elements/message.js");
const { ANSWER, cutAt, streamSplitter } = await import("../src/client/AnswerParts.js");

const FENCE = "```ts\nconst a = 1;\n\nfunction f() {\n\n  return a;\n}\n```\n";
const LOOSE = "1. first\n\n2. second, with a line after a blank one\n\n   still the second item\n\n3. third\n";
const TABLE = "| tool | speed |\n|---|---|\n| one | fast |\n| two | slow |\n";
const SAMPLE = [
  "## What changed",
  "Plain words with **bold**, `code` and a [link](https://example.com).",
  FENCE.trimEnd(),
  LOOSE.trimEnd(),
  "- tight\n- list\n  - nested",
  TABLE.trimEnd(),
  "~~~\ntilde fence\n\nwith a gap\n~~~",
  "> a quote\n> on two lines",
  "Heading by underline\n---",
  "    indented code\n\n    after a gap",
  "Last paragraph.",
].join("\n\n");

/** Streams `md` a few characters at a time through one splitter, as the live answer does, with what it gave at each step. */
function stream(md: string, step = 3) {
  const split = streamSplitter();
  const out: { text: string; done: string[]; tail: string }[] = [];
  for (let n = step; n < md.length + step; n += step) {
    const text = md.slice(0, n);
    out.push({ text, ...split(text) });
  }
  return out;
}
const inside = (cut: number, part: string) => {
  const at = SAMPLE.indexOf(part);
  return cut > at && cut < at + part.length;
};

test("the splitter cuts only where a block of the finished answer ends: never in a fence, a list or a table", () => {
  const ends = new Set<number>();
  let at = 0;
  for (const b of parseMarkdownIntoBlocks(SAMPLE)) ends.add((at += b.length));
  let cuts = 0;
  for (const step of [1, 3, 17]) {
    for (const { done } of stream(SAMPLE, step)) {
      let cut = 0;
      for (const piece of done) {
        cut += piece.length;
        assert.ok(ends.has(cut), `cut at ${cut} (step ${step}) is where a block of the whole answer ends`);
        for (const part of [FENCE, LOOSE, TABLE, "~~~\ntilde fence\n\nwith a gap\n~~~", "    indented code\n\n    after a gap"]) assert.ok(!inside(cut, part), `cut at ${cut} is not inside ${JSON.stringify(part.slice(0, 12))}`);
      }
      cuts = Math.max(cuts, done.length);
    }
  }
  assert.ok(cuts >= 6, `a long answer is cut into pieces (${cuts})`);
});

test("a blank line in a list or a fence is not a place to cut, until the next line says the block is over", () => {
  // "2" could still be "2. second", which would make one loose list of the two.
  assert.equal(cutAt("1. first\n\n2"), 0);
  assert.equal(cutAt("1. first\n\n2. second\n\nThen"), 0, "the line after isn't whole yet");
  assert.equal(cutAt("1. first\n\n2. second\n\nThen words.\n"), "1. first\n\n2. second\n\n".length);
  assert.equal(cutAt("- item\n\n  more of the item\n\nnext\n"), "- item\n\n  more of the item\n\n".length);
  assert.equal(cutAt("```\nopen fence\n\nstill code\n\nmore\n"), 0, "a fence still open is one block");
  assert.equal(cutAt("| a |\n|---|\n| 1 |\n| 2"), 0);
  assert.equal(cutAt("Para one.\n\nPara two\n"), "Para one.\n\n".length);
  // A footnote makes Streamdown keep the whole answer as one block, so it isn't cut either.
  assert.deepEqual(streamSplitter()("Para one.[^1]\n\nPara two\n\n[^1]: note\n").done, []);
});

test("the pieces and the tail are the blocks of the whole text at every step", () => {
  for (const { text, done, tail } of stream(SAMPLE, 5)) {
    assert.equal(done.join("") + tail, text);
    assert.deepEqual([...done.flatMap((p) => parseMarkdownIntoBlocks(p)), ...parseMarkdownIntoBlocks(tail)], parseMarkdownIntoBlocks(text), `at ${text.length}`);
  }
});

test("drawn piece by piece, the answer is drawn as the whole of it is", () => {
  // Each Streamdown wraps its blocks in one div; what is inside is compared.
  const inner = (md: string) => renderToStaticMarkup(h(MessageResponse, { ...ANSWER, children: md })).replace(/^<div[^>]*>|<\/div>$/g, "");
  const steps = stream(SAMPLE, 7);
  for (const i of [Math.floor(steps.length / 3), Math.floor((2 * steps.length) / 3), steps.length - 1]) {
    const { text, done, tail } = steps[i]!;
    assert.ok(done.length > 0 && inner(text).length > 500);
    assert.equal([...done, tail].map(inner).join(""), inner(text), `at ${text.length}`);
  }
});
