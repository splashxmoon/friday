import assert from "node:assert/strict";
import test from "node:test";
import { within } from "../src/runner/limits.js";

// The limits are read for the whole computer at once, and every source used to be waited for (up to eight seconds each) before
// Claude Code's figures showed (Arun, 2026-10-24: "make sure we are properly fetching the claude code usage limits it needs to
// be stabler and fast").
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a source that answers in time is its answer; a slow one's last answer stands in, and its new one is there next time", async () => {
  assert.equal(await within("t-fast", async () => "fresh", 200, "none"), "fresh");

  // Never answered before and slow: nothing to show yet, and no waiting past the budget.
  const t0 = Date.now();
  assert.equal(await within("t-slow", () => wait(150).then(() => "first"), 30, "none"), "none");
  assert.ok(Date.now() - t0 < 120, "it didn't wait for the slow source");
  await wait(200);
  // Slow again: the answer that came in behind the last ask stands in for this one.
  assert.equal(await within("t-slow", () => wait(150).then(() => "second"), 30, "none"), "first");
  await wait(200);
  assert.equal(await within("t-slow", async () => "third", 30, "none"), "third");
});

test("a source that fails keeps its last answer", async () => {
  assert.equal(await within("t-fail", async () => "good", 100, "none"), "good");
  assert.equal(await within("t-fail", () => Promise.reject(new Error("down")), 100, "none"), "good");
});

test("asks already under way are shared", async () => {
  let asked = 0;
  const read = () => (asked++, wait(40).then(() => "once"));
  const [a, b] = await Promise.all([within("t-share", read, 200, "none"), within("t-share", read, 200, "none")]);
  assert.deepEqual([a, b, asked], ["once", "once", 1]);
});
