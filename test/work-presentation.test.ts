// What a Work session's rail and reader say to a person (client/work-outputs.ts, work-files.ts blurbOf): titles, not file
// names; a collection's card, not an agent's working notes; one count of sources, numbered as they were read; plain words where
// an agent wrote Markdown (Arun, 2026-10-28: "iron everything… focusing on UI and UX"; "look for like the little details and
// designs too").
import assert from "node:assert/strict";
import test from "node:test";
import { chipTitle, fileTitle, hubPieces, hubsIn, learnTitles, pagesIn, pieceTitle, plainLine, sameTitled, shownIn, sourceCount, sourcesIn, titleIn } from "../src/client/work-outputs.js";
import type { WorkFile } from "../src/client/WorkPanels.js";
import { blurbOf } from "../src/work-files.js";

const file = (p: string, more: Partial<WorkFile> = {}): WorkFile => ({ root: 0, path: p, kind: /\.(png|jpe?g)$/.test(p) ? "image" : "doc", size: 1, mtime: 1, ...more });

test("a piece is called by its title wherever a person reads it, else its file's name as words", () => {
  assert.equal(pieceTitle(file("outputs/launch-week-calendar.html", { title: "Launch week content calendar" })), "Launch week content calendar");
  assert.equal(pieceTitle(file("outputs/friday-video-research.md", { title: "Friday: **organic** video research" })), "Friday: organic video research", "its marks off");
  assert.equal(pieceTitle(file("outputs/launch-cover.png")), "Launch cover", "a picture by its name as words");
  assert.equal(fileTitle("drafts/02_art_direction.md"), "Art direction", "its number and separators off");
  assert.equal(fileTitle("shot-plan.csv"), "Shot plan");
  assert.equal(pieceTitle(file("notes.txt", { title: "  " })), "Notes", "a blank title is no title");
  // Two pieces called the same say which file each is.
  const twins = sameTitled([file("README.md", { title: "Notes" }), file("notes.txt"), file("brief.md", { title: "Brief" })]);
  assert.deepEqual([...twins].sort(), ["0|README.md", "0|notes.txt"]);
  // The chat's chips: the title the rail read, else the name as words.
  learnTitles([file("outputs/launch-week-calendar.html", { title: "Launch week content calendar" })]);
  assert.equal(chipTitle("outputs/launch-week-calendar.html"), "Launch week content calendar");
  assert.equal(chipTitle("./outputs/launch-week-calendar.html"), "Launch week content calendar");
  assert.equal(chipTitle("outputs/never-read.md"), "Never read");
});

test("what an agent last said reads as words: no heading marks, stars, backticks or link syntax", () => {
  assert.equal(plainLine("## Tuning results"), "Tuning results");
  assert.equal(plainLine("Done: I added a **Notes** section to `README.md`."), "Done: I added a Notes section to README.md.");
  assert.equal(plainLine("See [the brief](brief.md) and _this_ one"), "See the brief and this one");
  assert.equal(plainLine("- [x] a step\n> quoted"), "[x] a step quoted");
  assert.equal(plainLine("snake_case_name stays"), "snake_case_name stays", "underscores inside a word are not emphasis");
});

test("a collection's card says what it is: its description, else its first plain paragraph, never an agent's working notes", () => {
  const lines = (t: string) => t.split("\n");
  const home = `# Friday Studio

Status: foundation draft. The user has now authorized production of the handoff pilot; see the brief.

Purpose: establish an original, repeatable animated series for Friday before producing more episodes.

## Start here`;
  assert.equal(blurbOf(lines(home), "# Friday Studio"), "Establish an original, repeatable animated series for Friday before producing more episodes.");
  assert.equal(blurbOf(lines("# X\n\nThe user asked for a thread.\nStill notes.\n\nA week of launch posts."), "# X"), "A week of launch posts.", "a paragraph that opens as a note goes whole");
  assert.equal(blurbOf(lines("# X\n\n**Note:** internal.\n\nSummary: the launch, in posts."), "# X"), "The launch, in posts.");
  assert.equal(blurbOf(lines("# X\n\nFirst words."), "# X", "title: X\ndescription: \"Everything for the launch.\""), "Everything for the launch.", "its own description first");
  assert.equal(blurbOf(lines("# X\n\nStatus: draft."), "# X"), "", "nothing but notes says nothing");
});

test("a collection's card and its page count the same pieces: not its own collection.md, nor its sources", () => {
  const files = [file("launch/collection.md", { title: "Launch" }), file("launch/thread.md"), file("launch/brief.md"), file("launch/sources.md"), file("launch/cover.png")];
  const [hub] = hubsIn(files);
  assert.ok(hub);
  assert.deepEqual(hubPieces(hub).map((f) => f.path).sort(), ["launch/brief.md", "launch/cover.png", "launch/thread.md"]);
});

const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });
const said = (ts: number, calls: ReturnType<typeof call>[]) => ({ ts, seq: ts, lane: "main", actor: { name: "Claude Code" }, body: { type: "agent.message", text: "", toolCalls: calls } });
const result = (callId: string, output: string) => ({ ts: 0, seq: 0, lane: "main", actor: { name: "Claude Code" }, body: { type: "tool.result", callId, name: "x", output, isError: false } });

test("sources are the pages a search turned up and the pages read, numbered as first read, under their search, counted once", () => {
  const events = [
    said(1, [call("s1", "web_search", { query: "intl number format" })]),
    result("s1", 'Results:\n[{"title":"Intl.NumberFormat - MDN","url":"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat"},{"title":"ECMA-402","url":"https://tc39.es/ecma402/"}]'),
    said(2, [call("f1", "web_fetch", { url: "https://tc39.es/ecma402/#top" }), call("f2", "WebFetch", { url: "https://news.ycombinator.com/item?id=1" })]),
    result("f2", "Title: Show HN: Friday\n\nSome page text"),
  ] as never;
  const found = sourcesIn(events, { lanes: [] } as never);
  assert.deepEqual(
    found.map((s) => [s.kind, s.n ?? null, s.title ?? s.text, s.of ?? null]),
    [
      ["search", null, "intl number format", null],
      ["page", 1, "Intl.NumberFormat - MDN", "intl number format"],
      ["page", 2, "ECMA-402", "intl number format"],
      ["page", 3, "Show HN: Friday", null],
    ],
    "the page fetched again after its search is the same page, numbered once",
  );
  assert.deepEqual(sourceCount(found), { n: 3, word: "source" }, "as many as a reply's own sources say");
  assert.deepEqual(sourceCount(sourcesIn([said(1, [call("s", "web_search", { query: "x" })])] as never, { lanes: [] } as never)), { n: 1, word: "search" }, "a search that found nothing yet is a search");
});

test("a search's pages and a page's title are read as the tools write them", () => {
  assert.deepEqual(pagesIn("- Launch threads https://x.com/a/status/1\n[Docs](https://docs.example.com/a)"), [
    { url: "https://docs.example.com/a", title: "Docs" },
    { url: "https://x.com/a/status/1", title: "Launch threads" },
  ]);
  assert.deepEqual(pagesIn("nothing here, javascript:alert(1)"), []);
  assert.equal(titleIn("<html><head><title>A page</title>"), "A page");
  assert.equal(titleIn("# Its heading\n\ntext"), "Its heading");
  assert.equal(titleIn("just text"), undefined);
});

test("what an agent drew in the chat reaches Outputs, by its own title, newest first", () => {
  const msg = (seq: number, text: string) => ({ seq, ts: seq, lane: "main", actor: { name: "Claude Code" }, body: { type: "agent.message", text, toolCalls: [] } });
  const events = [
    msg(1, "Here:\n```mermaid\nflowchart LR\n  a --> b\n```\nand\n```html\n<title>Launch chart</title><div></div>\n```"),
    msg(2, "```svg\n<svg><title>Cover sketch</title><text>a label</text></svg>\n```\n```ts\nconst x = 1\n```"),
  ] as never;
  assert.deepEqual(
    shownIn(events).map((s) => [s.seq, s.at, s.kind, s.title]),
    [
      [2, 0, "svg", "Cover sketch"],
      [1, 1, "html", "Launch chart"],
      [1, 0, "mermaid", "A flowchart"],
    ],
  );
  // No title of its own: the line that led into it, else what sort of drawing it is (QA, 2026-10-28: every one "A diagram").
  const more = [msg(3, "Here's how a session flows:\n```mermaid\nsequenceDiagram\n  a->>b: hi\n```\n```svg\n<svg><text>Launch week</text></svg>\n```\n```mermaid\npie\n  \"a\": 1\n```")] as never;
  assert.deepEqual(
    shownIn(more).map((s) => s.title),
    ["A pie chart", "Launch week", "How a session flows"],
  );
});
