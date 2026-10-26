import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreRace, type Racer } from "../src/race-score.js";

const r = (over: Partial<Racer>): Racer => ({ id: "x", name: "X", tests: "pass", red: 0, files: 2, added: 40, removed: 10, seconds: 120, tokens: 8000, commands: 5, finished: true, ...over });
const A = (o: Partial<Racer> = {}) => r({ id: "a", name: "Claude Code", ...o });
const B = (o: Partial<Racer> = {}) => r({ id: "b", name: "Codex", ...o });
const row = (v: ReturnType<typeof scoreRace>, k: string) => v.rows.find((x) => x.key === "tests" ? k === "tests" : x.key === k)!;

test("passing tests beat failing ones, and say why", () => {
  const v = scoreRace(A({ tests: "fail" }), B({ tests: "pass" }));
  assert.equal(v.lean, "b");
  assert.equal(row(v, "tests").better, "b");
  assert.match(v.why, /Codex: its tests passed, Claude Code's failed/);
});

test("a run that switched a test off does not win on its green", () => {
  const v = scoreRace(A({ tests: "pass", red: 1 }), B({ tests: "fail", red: 0 }));
  assert.equal(v.lean, "b", "the flag outranks the pass");
  assert.match(v.why, /Claude Code has 1 red flag/);
});

test("with equal tests the smaller change leans, but a few lines either way do not", () => {
  assert.equal(scoreRace(A({ added: 10, removed: 2 }), B({ added: 200, removed: 80 })).lean, "a");
  assert.match(scoreRace(A({ added: 10, removed: 2 }), B({ added: 200, removed: 80 })).why, /smaller \(12 lines against 280\)/);
  const close = scoreRace(A({ added: 40, removed: 10 }), B({ added: 44, removed: 10 }));
  assert.equal(close.lean, null);
  assert.equal(row(close, "size").better, "tie");
});

test("a smaller change only counts when the tests are level: small and broken is not better", () => {
  const v = scoreRace(A({ added: 2, removed: 0, tests: "fail" }), B({ added: 300, removed: 90, tests: "pass" }));
  assert.equal(v.lean, "b");
});

test("a tie is a tie, and the verdict says to read the code", () => {
  const v = scoreRace(A(), B());
  assert.equal(v.lean, null);
  assert.match(v.why, /Nothing separates them/);
});

test("speed alone never makes a verdict, but is reported when all else is level", () => {
  const v = scoreRace(A({ seconds: 30 }), B({ seconds: 300 }));
  assert.equal(v.lean, null);
  assert.equal(row(v, "time").better, "a");
  assert.match(v.why, /Claude Code was faster/);
});

test("tokens are compared only when both report them", () => {
  assert.equal(row(scoreRace(A({ tokens: null }), B({ tokens: 5000 })), "tokens").better, "unknown");
  assert.equal(row(scoreRace(A({ tokens: null }), B({ tokens: 5000 })), "tokens").a, "not counted");
  assert.equal(row(scoreRace(A({ tokens: 1000 }), B({ tokens: 9000 })), "tokens").better, "a");
});

test("nothing is concluded before both have finished", () => {
  const v = scoreRace(A({ finished: false, tests: "none" }), B());
  assert.equal(v.lean, null);
  assert.equal(v.why, "Not both finished yet.");
  assert.equal(row(v, "time").better, "unknown");
});

test("the numbers are written the way a person reads them", () => {
  const v = scoreRace(A({ seconds: 75, tokens: 48000, files: 1 }), B({ seconds: 5, tokens: 1200 }));
  assert.equal(row(v, "time").a, "1m 15s");
  assert.equal(row(v, "time").b, "5s");
  assert.equal(row(v, "tokens").a, "48k");
  assert.equal(row(v, "tokens").b, "1.2k");
  assert.match(row(v, "size").a, /^1 file,/);
});

import { scoreMany } from "../src/race-score.js";
const C = (o: Partial<Racer> = {}) => r({ id: "c", name: "Gemini", ...o });

test("three or more attempts: the best on each metric is marked, and the verdict names every loser", () => {
  const v = scoreMany([A({ tests: "fail" }), B({ tests: "pass" }), C({ tests: "none" })]);
  assert.equal(v.lean, "b");
  assert.deepEqual(v.rows.find((x) => x.key === "tests")!.best, [1]);
  assert.match(v.why, /Codex: its tests passed, Claude Code's failed and Gemini's not run/);
  const size = scoreMany([A({ added: 10, removed: 2 }), B({ added: 200, removed: 80 }), C({ added: 190, removed: 70 })]);
  assert.equal(size.lean, "a");
  assert.match(size.why, /smaller \(12 lines against 280 and 260\)/);
  const level = scoreMany([A(), B(), C()]);
  assert.equal(level.lean, null);
  assert.deepEqual(level.rows.find((x) => x.key === "size")!.best, [], "all level: nobody is best");
  assert.equal(scoreMany([A({ finished: false }), B(), C()]).why, "Not all finished yet.");
});

test("two close and one far off: the two close ones are both best, so there is no lean on size", () => {
  const v = scoreMany([A({ added: 10, removed: 0 }), B({ added: 11, removed: 0 }), C({ added: 300, removed: 50 })]);
  assert.deepEqual(v.rows.find((x) => x.key === "size")!.best, [0, 1]);
  assert.equal(v.lean, null);
});

test("two out in front and one behind on tests: the front runners are named, with who fell behind", () => {
  const v = scoreMany([A({ tests: "pass" }), B({ tests: "fail" }), C({ tests: "pass" })]);
  assert.equal(v.lean, null);
  assert.match(v.why, /Claude Code and Gemini are level on tests and size; Codex's tests failed\. Read both changes and choose\./);
});
