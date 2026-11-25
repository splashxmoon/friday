import assert from "node:assert/strict";
import { test } from "node:test";
import { addedSince, eventsAfter, logFold, logMemo } from "../src/client/log-memo.js";
import type { SessionEvent } from "../src/types.js";

/** What the feed works out from a long log, carried from one event to the next (spec 13): only what was added is read again. */

const ev = (seq: number, type = "agent.message"): SessionEvent => ({ seq, ts: seq, actor: { id: "a", name: "A", kind: "agent" }, body: { type, text: "", toolCalls: [] } }) as unknown as SessionEvent;
const log = (n: number) => Array.from({ length: n }, (_, i) => ev(i + 1, i % 5 ? "agent.message" : "run.started"));

test("a log grown at its end gives what was added; anything else starts again", () => {
  const a = log(10);
  const keep = { current: null as never };
  logFold(keep, a, () => 0, (n) => n + 1);
  const seen = (keep as { current: { seen: Parameters<typeof addedSince>[0] } }).current.seen;
  assert.deepEqual(addedSince(seen, [...a, ev(11)])?.map((e) => e.seq), [11]);
  assert.deepEqual(addedSince(seen, a), []);
  assert.equal(addedSince(seen, a.slice(0, 9)), null, "shorter");
  assert.equal(addedSince(seen, [ev(0), ...a]), null, "opened further back");
  assert.equal(addedSince(seen, [...a.slice(0, 9), ev(99)]), null, "not the same events");
  assert.equal(addedSince(seen, [...a, ev(11)], "another key"), null, "another view of it");
});

test("a fold reads each event once, and the whole log again when it isn't the same one grown", () => {
  const keep = { current: null as never };
  let looked = 0;
  const count = (k: { current: never }, l: SessionEvent[], key?: string) => logFold(k, l, () => 0, (n, e) => (looked++, n + (e.body.type === "run.started" ? 1 : 0)), key);
  const a = log(1000);
  assert.equal(count(keep, a), 200);
  looked = 0;
  assert.equal(count(keep, [...a, ev(1001, "run.started")]), 201);
  assert.equal(looked, 1, "only the new event");
  looked = 0;
  assert.equal(count(keep, log(50)), 10, "another log");
  assert.equal(looked, 50);
  looked = 0;
  assert.equal(count(keep, log(50), "me"), 10, "another key");
  assert.equal(looked, 50);
});

test("a memo is made again only when an event it reads is added", () => {
  const keep = { current: null as never };
  let made = 0;
  const starts = (l: readonly SessionEvent[]) => logMemo(keep, l, (x) => (made++, x.filter((e) => e.body.type === "run.started").length), (e) => e.body.type === "run.started");
  const a = log(100);
  assert.equal(starts(a), 20);
  assert.equal(starts([...a, ev(101)]), 20);
  assert.equal(made, 1, "an event it doesn't read leaves it");
  assert.equal(starts([...a, ev(101), ev(102, "run.started")]), 21);
  assert.equal(made, 2);
});

test("eventsAfter reads from the end", () => {
  const a = log(20);
  assert.deepEqual(eventsAfter(a, 17).map((e) => e.seq), [18, 19, 20]);
  assert.equal(eventsAfter(a, 0).length, 20);
  assert.equal(eventsAfter(a, 20).length, 0);
});
