import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { ANSWER } from "../src/client/AnswerParts.js";
import { fileLinkOf } from "../src/client/answer-format.js";

// An agent's links to its files, as a Crew teammate wrote them: drawn "working plan [blocked]" and "download audit [blocked]" by
// the Markdown hardener (Arun, 2026-10-29). Now each is the app's file chip, and a link that must stay refused is its words alone.
const said = [
  "Here is the [working plan](working-plan.md), the [download audit](file:///Users/arun/Friday/mates/kit/audit.pdf),",
  "notes in [the folder](./notes/launch%20notes.md) and [the site](https://example.com/docs).",
  "Never [click me](javascript:alert(1)) or [this](data:text/html,hi).",
].join(" ");

const html = (md: string) => {
  (globalThis as { window?: unknown }).window ??= { dispatchEvent: () => true };
  return renderToStaticMarkup(createElement(Streamdown, { ...ANSWER, children: md } as never));
};

test("a link to a file is the path it names, from any way of writing one; a web address or a fragment isn't", () => {
  assert.equal(fileLinkOf("working-plan.md"), "working-plan.md");
  assert.equal(fileLinkOf("./notes/launch%20notes.md"), "notes/launch notes.md");
  assert.equal(fileLinkOf("file:///Users/arun/a.pdf"), "/Users/arun/a.pdf");
  assert.equal(fileLinkOf("/Users/arun/a.md#top"), "/Users/arun/a.md");
  assert.equal(fileLinkOf("https://example.com/a.md"), null);
  assert.equal(fileLinkOf("mailto:a@b.c"), null);
  assert.equal(fileLinkOf("#heading"), null);
  assert.equal(fileLinkOf("docs/"), null);
});

test("links to files are file chips, refused links plain words, and nothing says [blocked]", () => {
  const out = html(said);
  assert.ok(!out.includes("[blocked]"), out);
  assert.match(out, /class="file-chip"[^>]*aria-label="Open working plan"/);
  assert.match(out, /title="Open working-plan\.md/);
  assert.match(out, /title="Open \/Users\/arun\/Friday\/mates\/kit\/audit\.pdf/);
  assert.match(out, /title="Open notes\/launch notes\.md/);
  assert.match(out, /data-streamdown="link"[^>]*>the site</, "a web address stays a link");
  assert.match(out, /Never click me or this\./);
  assert.ok(!/javascript:|data:text/.test(out), out);
});
