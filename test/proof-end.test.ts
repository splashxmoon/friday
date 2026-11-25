// A proof card's end has to land (src/proof-end.ts, used by app.ts testWork and proveRun; spec 13, "What can break" 12): a
// "failed" that didn't go through left the card on "testing" for ever.
import assert from "node:assert/strict";
import test from "node:test";
import { appendSurely } from "../src/proof-end.js";

test("an end that fails at first is tried again until it lands", async () => {
  let calls = 0;
  const ok = await appendSurely(
    async () => {
      if (++calls < 3) throw new Error("store busy");
    },
    "A check's end",
    { waitMs: 1 },
  );
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test("one that never lands is said in the log and given up on, never thrown", async (t) => {
  const said: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  t.after(() => (console.error = was));
  let calls = 0;
  const ok = await appendSurely(
    () => {
      calls++;
      return Promise.reject(new Error("disk full"));
    },
    "A check's end",
    { tries: 4, waitMs: 1 },
  );
  assert.equal(ok, false);
  assert.equal(calls, 4);
  assert.equal(said.length, 1);
  assert.match(said[0]!, /\[proof\] A check's end couldn't be saved after 4 tries: disk full/);
});

test("one that lands first time is written once", async () => {
  let calls = 0;
  assert.equal(await appendSurely(async () => void calls++, "x"), true);
  assert.equal(calls, 1);
});
