import assert from "node:assert/strict";
import test from "node:test";
import { webSourcesIn } from "../src/web-sources.js";

test("Friday's own search: the findings, then its titled sources", () => {
  const out = "Electron 44 added X (October 2026) https://www.electronjs.org/blog/electron-44-0.\n\nSources:\n- Electron 44.0.0 | Electron https://www.electronjs.org/blog/electron-44-0\n- Releases https://github.com/electron/electron/releases";
  assert.deepEqual(webSourcesIn(out), [
    { url: "https://www.electronjs.org/blog/electron-44-0", title: "Electron 44.0.0 | Electron" },
    { url: "https://github.com/electron/electron/releases", title: "Releases" },
  ]);
});

test("Claude Code's links, Markdown links and bare addresses", () => {
  const cc = 'Web search results for query: "webcontentsview"\n\nLinks: [{"title":"WebContentsView | Electron","url":"https://www.electronjs.org/docs/latest/api/web-contents-view"},{"url":"https://example.com/a","title":"A \\"quoted\\" page"}]';
  assert.deepEqual(webSourcesIn(cc), [
    { url: "https://www.electronjs.org/docs/latest/api/web-contents-view", title: "WebContentsView | Electron" },
    { url: "https://example.com/a", title: 'A "quoted" page' },
  ]);
  assert.deepEqual(webSourcesIn("See [the docs](https://docs.example.com/x) and https://other.example.org/y."), [
    { url: "https://docs.example.com/x", title: "the docs" },
    { url: "https://other.example.org/y" },
  ]);
  assert.deepEqual(webSourcesIn("nothing here"), []);
});

test("search output never breaks a reply: bad escapes keep their text, and only web addresses are kept", () => {
  // A Windows path or a regex in a title is a bad JSON escape: kept as written, never thrown.
  assert.deepEqual(webSourcesIn(String.raw`{"title":"C:\Windows","url":"https://c.com"}`), [{ url: "https://c.com/", title: String.raw`C:\Windows` }]);
  assert.doesNotThrow(() => webSourcesIn(String.raw`{"title":"bad \x esc","url":"https://d.com/x"}`));
  // A javascript: or data: link never becomes a source.
  assert.deepEqual(webSourcesIn('{"title":"Click","url":"javascript:alert(1)"}'), []);
  assert.deepEqual(webSourcesIn('{"url":"data:text/html,<script>alert(1)</script>","title":"x"}'), []);
  assert.deepEqual(webSourcesIn("[x](javascript:alert(1))"), []);
});
