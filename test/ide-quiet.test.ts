// Pings held while you type (src/client/ide/quiet-queue.ts): held only after a key, released as one line after 20 seconds of none.
import assert from "node:assert/strict";
import test from "node:test";
import { createHold, QUIET_MS, summarize } from "../src/client/ide/quiet-queue.js";

test("nothing is held until a key is pressed", () => {
  const h = createHold();
  assert.equal(h.hold({ kind: "done", sid: "a", title: "Fix login" }, 1000), false);
  assert.equal(h.size(), 0);
});

test("held while typing, released only after the pause", () => {
  const h = createHold();
  h.typed(1000);
  assert.equal(h.hold({ kind: "done", sid: "a", title: "Fix login" }, 5000), true);
  assert.deepEqual(h.release(5000), [], "still typing");
  assert.deepEqual(h.release(1000 + QUIET_MS - 1), []);
  assert.equal(h.wait(5000), 1000 + QUIET_MS - 5000);
  const out = h.release(1000 + QUIET_MS);
  assert.equal(out.length, 1);
  assert.equal(h.size(), 0);
  assert.equal(h.wait(99_000), 0);
});

test("each key starts the pause over", () => {
  const h = createHold();
  h.typed(0);
  h.hold({ kind: "waiting", sid: "a", title: "x", seq: 1 }, 1);
  h.typed(15_000);
  assert.deepEqual(h.release(QUIET_MS + 1), []);
  assert.equal(h.release(15_000 + QUIET_MS).length, 1);
});

test("the same wait or run held twice is one; a key from the past changes nothing", () => {
  const h = createHold();
  h.typed(10_000);
  h.typed(5_000);
  h.hold({ kind: "waiting", sid: "a", title: "x", seq: 1 }, 10_001);
  h.hold({ kind: "waiting", sid: "a", title: "x", seq: 1 }, 10_002);
  h.hold({ kind: "waiting", sid: "a", title: "x", seq: 2 }, 10_003);
  h.hold({ kind: "done", sid: "b", title: "y" }, 10_004);
  h.hold({ kind: "done", sid: "b", title: "y again" }, 10_005);
  const out = h.release(10_000 + QUIET_MS);
  assert.equal(out.length, 3);
  assert.equal(out.find((i) => i.kind === "done")?.title, "y again");
});

test("forcing releases at once (the setting turned off), and reset forgets the keys", () => {
  const h = createHold();
  h.typed(100);
  h.hold({ kind: "done", sid: "a", title: "t" }, 101);
  assert.equal(h.release(102, true).length, 1);
  h.reset();
  assert.equal(h.typing(103), false);
});

test("the summary says what finished and how many wait", () => {
  assert.equal(summarize([]), "");
  assert.equal(summarize([{ kind: "done", sid: "a", title: "Claude Code" }]), "While you were typing: Claude Code finished");
  assert.equal(
    summarize([
      { kind: "done", sid: "a", title: "Claude Code" },
      { kind: "waiting", sid: "b", title: "x", seq: 1 },
      { kind: "waiting", sid: "c", title: "y", seq: 1 },
    ]),
    "While you were typing: Claude Code finished · 2 waiting",
  );
  assert.equal(
    summarize([
      { kind: "done", sid: "a", title: "A" },
      { kind: "done", sid: "b", title: "B" },
    ]),
    "While you were typing: 2 finished",
  );
  assert.equal(summarize([{ kind: "done", sid: "a", title: "" }]), "While you were typing: A session finished");
});
