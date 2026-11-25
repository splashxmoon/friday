import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * A table in an agent's answer in the IDE's chat column (about 340px wide): its first column's cell must wrap, not stay on one
 * line and run into the next column. Pinned in the stylesheet, as the other layout rules are.
 */
const css = readFileSync(new URL("../src/client/ide/agent-panel.css", import.meta.url), "utf8");

test("a table's first column wraps in the agent chat instead of running into the next column", () => {
  assert.match(
    css,
    /\.ia-chat \.rsp-answer \[data-streamdown="table"\] :is\(th, td\):first-child[^{]*\{[^}]*white-space: normal;[^}]*max-width: none;/,
    "the first column cell must wrap (white-space: normal) and drop its 340px cap (max-width: none)",
  );
});
