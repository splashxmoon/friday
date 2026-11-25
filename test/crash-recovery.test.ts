// The desktop app's window after its page dies (src/local/crash-recovery.ts, used by src/local/desktop.ts render-process-gone; spec
// 13, "What can break" 2). Electron itself can't be driven here, so the counting and the error page are tested on their own.
import assert from "node:assert/strict";
import test from "node:test";
import { CrashGuard, errorPage, errorPageUrl, goneWords } from "../src/local/crash-recovery.js";

test("a crashed page is reloaded three times in a minute, then the error page shows", () => {
  let now = 1_000_000;
  const g = new CrashGuard(3, 60_000, () => now);
  assert.equal(g.gone("crashed"), "reload");
  now += 5_000;
  assert.equal(g.gone("oom"), "reload");
  now += 5_000;
  assert.equal(g.gone("killed"), "reload");
  assert.equal(g.recent, 3);
  now += 5_000;
  assert.equal(g.gone("crashed"), "error-page", "a fourth in the minute");
  assert.equal(g.gone("crashed"), "error-page");
});

test("crashes older than the minute don't count, so a page that dies now and then is always brought back", () => {
  let now = 0;
  const g = new CrashGuard(3, 60_000, () => now);
  for (let i = 0; i < 10; i++) {
    assert.equal(g.gone("oom"), "reload", `crash ${i + 1}, 25 s after the one before`);
    now += 25_000;
  }
  assert.ok(g.recent <= 3);
});

test("a page that ended as asked isn't a crash, and Reload on the error page gives the three back", () => {
  let now = 0;
  const g = new CrashGuard(3, 60_000, () => now);
  assert.equal(g.gone("clean-exit"), "none");
  assert.equal(g.recent, 0, "not counted");
  for (let i = 0; i < 3; i++) g.gone("crashed");
  assert.equal(g.gone("crashed"), "error-page");
  g.reset();
  assert.equal(g.recent, 0);
  assert.equal(g.gone("crashed"), "reload");
});

test("the error page says what happened plainly, offers its three buttons, and loads with nothing fetched", () => {
  const html = errorPage({ reason: "oom", times: 3 });
  assert.match(html, /<h1>Friday's window ran out of memory<\/h1>/);
  assert.match(html, /reloaded 3 times in the last minute/);
  assert.match(html, /Your sessions and agents are still running/);
  for (const b of ["Reload", "Copy diagnostics", "Show log file"]) assert.match(html, new RegExp(`>${b}</button>`));
  assert.match(html, /fridayDesktop\.recover\(what\)/, "its buttons go through the preload's recover");
  assert.match(html, /default-src 'none'/, "nothing loaded from anywhere");
  assert.ok(!/https?:\/\//.test(html), "no address in it");
  assert.match(html, /prefers-color-scheme: dark/, "both themes");
  const url = errorPageUrl(html);
  assert.ok(url.startsWith("data:text/html;charset=utf-8,"));
  assert.equal(decodeURIComponent(url.slice(url.indexOf(",") + 1)), html);
  // A reason Chromium adds later is still said, escaped.
  assert.match(errorPage({ reason: "<new>", times: 1 }), /stopped \(&lt;new&gt;\)/);
  assert.match(errorPage({ reason: "crashed", times: 1 }), /reloaded once/);
});

test("every reason Electron gives reads as words", () => {
  for (const r of ["abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction"]) assert.doesNotMatch(goneWords(r), /\(/, r);
});
