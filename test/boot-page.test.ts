import assert from "node:assert/strict";
import test from "node:test";
import { bootPage, bootPageUrl } from "../src/local/boot-page.js";

// The desktop app's window while Friday starts (desktop.ts): the app's own ground and mark in the theme the page last had, no script,
// the whole of it draggable, "Starting Friday…" only after two seconds (spec 13, Wave 2 · G).
test("the page shown while Friday starts: the app's ground and mark in either theme, nothing to run, draggable", () => {
  const light = bootPage({ theme: "light" });
  const dark = bootPage({ theme: "dark" });
  assert.match(light, /background: #fafaf9/);
  assert.match(light, /path \{ fill: #17171a; \}/);
  assert.match(dark, /background: #1c1c1c/);
  assert.match(dark, /path \{ fill: #f1f1f3; \}/);
  assert.match(dark, /color-scheme: dark/);
  assert.match(bootPage({ theme: "dark", glass: true }), /background: transparent/, "Frosted: the system's blur shows through");
  for (const html of [light, dark]) {
    assert.doesNotMatch(html, /<script/i, "no script");
    assert.match(html, /default-src 'none'/, "nothing loaded from anywhere");
    assert.match(html, /-webkit-app-region: drag/, "the window can be moved while it shows");
    assert.match(html, /animation: show 0\.4s ease-out 2s forwards/, "the words wait two seconds");
    assert.match(html, /prefers-reduced-motion/);
  }
  const url = bootPageUrl(light);
  assert.ok(url.startsWith("data:text/html"), "a page of the window's own, as the crash page is (desktop.ts onErrorPage)");
  assert.equal(decodeURIComponent(url.slice(url.indexOf(",") + 1)), light);
});
