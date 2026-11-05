import assert from "node:assert/strict";
import test from "node:test";
import { isOwnUrl } from "../src/local/own-url.js";

/**
 * Which addresses the open-source desktop app (src/local/desktop.ts) keeps in its window and lets use its bridge (terminals,
 * "Open in", the folder picker): Friday's own origin, exactly. A prefix check let a page at 127.0.0.1:4321@evil.example, or
 * another server on 127.0.0.1:43210, navigate the window and then start a shell through it.
 */
const app = "http://127.0.0.1:4321";

test("Friday's own pages count as its own", () => {
  assert.equal(isOwnUrl("http://127.0.0.1:4321/", app), true);
  assert.equal(isOwnUrl("http://127.0.0.1:4321/?session=abc#x", app), true);
});

test("a look-alike that starts with Friday's address is not Friday", () => {
  assert.equal(isOwnUrl("http://127.0.0.1:4321@evil.example/", app), false);
  assert.equal(isOwnUrl("http://127.0.0.1:43210/", app), false);
  assert.equal(isOwnUrl("http://localhost:4321/", app), false);
  assert.equal(isOwnUrl("https://127.0.0.1:4321/", app), false);
  assert.equal(isOwnUrl("not a url", app), false);
  assert.equal(isOwnUrl("", app), false);
});
