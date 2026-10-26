import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isNarrow } from "../src/client/narrow.js";
import { activates } from "../src/client/Sidebar.js";

/**
 * The signed-in app in a narrow or zoomed window (Testing F-20, A11Y-1: blank at 1000px and below) and its sidebar rows by
 * keyboard (F-21, A11Y-2). The layout itself was checked in a browser at 375, 640, 1000 and 1280px; these pin the rules.
 */
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const narrowBlocks = [...css.matchAll(/@media \(max-width: 1000px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]!).join("\n");

test("1000px and narrower: the page has the whole width, and a browser shows the list's own button", () => {
  assert.equal(isNarrow(1000), true, "the same edge as the stylesheet's max-width: 1000px");
  assert.equal(isNarrow(1001), false);
  assert.match(narrowBlocks, /\.shell, \.shell\.with-panel \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(narrowBlocks, /\.shell > \.main \{ grid-column: 1; grid-row: 1; \}/, "the page isn't left in the folded list's 0px column");
  assert.match(narrowBlocks, /\.shell\.with-chat, \.shell\.with-panel\.with-chat \{ grid-template-columns: minmax\(0, 1fr\) var\(--chat-w\); \}/, "the desktop app's team chat keeps its column");
  assert.match(narrowBlocks, /html:not\(\.desktop\) \.shell > \.main \{ margin-top: 44px !important; \}/, "the button has a strip of its own, over no header");
  assert.match(narrowBlocks, /html:not\(\.desktop\) \.win-nav \{ display: flex;/, "a way back to the list without a keyboard");
});

test("a sidebar row opens on Enter and Space, and its actions button stays in the Tab order", () => {
  const row = {};
  const key = (k: string, target: unknown = row) => {
    let prevented = false;
    return { ok: activates({ key: k, target, currentTarget: row, preventDefault: () => void (prevented = true) }), prevented };
  };
  assert.deepEqual(key("Enter"), { ok: true, prevented: false });
  assert.deepEqual(key(" "), { ok: true, prevented: true }, "Space opens it without scrolling the list");
  assert.equal(key("a").ok, false);
  assert.equal(key(" ", {}).ok, false, "a space typed in the rename box is the box's");
  const globals = readFileSync(new URL("../src/client/styles/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(globals, /\.dass-row-act \{ @apply hidden; \}/, "display:none took it out of the Tab order");
  assert.match(globals, /\.dass-row-act \{ position: absolute; width: 1px;/);
});

test("the Share panel stays on screen in a window under 640px (Marketing: it opened off the left edge at 540px)", () => {
  assert.match(css, /@media \(max-width: 640px\) \{\s*\.share-pop \{ position: fixed; left: 8px; right: 8px; top: calc\(var\(--band, 0px\) \+ 56px\);/);
});
