import assert from "node:assert/strict";
import test from "node:test";
import { liveDocument } from "../src/client/LiveBlock.js";

/**
 * What an agent shows in the chat runs in a sandboxed frame. These are the parts of the page that keep it safe and in
 * Friday's look, whatever the agent wrote.
 */

const CSP = /<meta http-equiv="Content-Security-Policy" content="[^"]*connect-src 'none'[^"]*form-action 'none'/;

test("every page carries Friday's policy first in its head, so an agent's page can only narrow it", () => {
  const own = liveDocument("html", `<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><p>hi</p></body></html>`, true);
  assert.match(own, CSP);
  assert.ok(own.indexOf("connect-src 'none'") < own.indexOf("default-src *"), "Friday's comes before the page's own");
  assert.match(liveDocument("html", `<div class="card">a fragment</div>`, false), CSP, "a fragment is set on a page with it too");
  assert.match(liveDocument("svg", `<svg viewBox="0 0 10 10"></svg>`, true), CSP);
  assert.match(liveDocument("mermaid", "flowchart LR\n A --> B", true), CSP);
});

test("a diagram's source goes in as text: markup in it never runs", () => {
  const doc = liveDocument("mermaid", `flowchart LR\n A["<img src=x onerror=alert(1)>"] --> B`, true);
  assert.doesNotMatch(doc, /<img src=x/);
  assert.match(doc, /&lt;img src=x onerror=alert\(1\)>/);
});

test("the page has Friday's kit in the theme it is shown in, and Chart.js is themed as it loads", () => {
  const dark = liveDocument("html", "<canvas></canvas>", true);
  const light = liveDocument("html", "<canvas></canvas>", false);
  assert.match(dark, /--fg:#ededed/);
  assert.match(light, /--fg:#18181b/);
  assert.match(dark, /--series-1:#3987e5/, "the validated palette, dark steps");
  assert.match(light, /--series-1:#2a78d6/, "and light steps");
  assert.match(dark, /\.stat \.value\{/);
  assert.match(dark, /Object\.defineProperty\(window,"Chart"/);
  assert.match(dark, /live-size/, "and it says how tall it is");
});

test("opened large, a diagram or drawing fills its space; in the chat a wide diagram keeps a readable size and scrolls", () => {
  const big = liveDocument("mermaid", "flowchart LR\n A --> B", false, true);
  const inline = liveDocument("mermaid", "flowchart LR\n A --> B", false);
  assert.match(big, /\.mermaid svg\{width:100%!important;height:100%!important/);
  assert.doesNotMatch(big, /const fit=/, "large, nothing holds it to its own size");
  assert.match(inline, /w\*0\.7>document\.body\.clientWidth/, "in the chat, never under 70% of its size");
  assert.match(inline, /g\.style\.flex=narrow\?"none"/, "and the row it sits in can't squeeze it past that");
  assert.match(liveDocument("svg", `<svg viewBox="0 0 10 10"></svg>`, true, true), /svg\{width:100%!important/);
});
