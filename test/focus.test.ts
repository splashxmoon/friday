import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanFocus, sameFocus, watchersOf } from "../src/focus.js";

test("only known places get through, and nothing that is not a place", () => {
  assert.deepEqual(cleanFocus({ panel: "files", lane: "main", path: "src/app.ts", line: 12 }), { panel: "files", lane: "main", path: "src/app.ts", line: 12 });
  assert.deepEqual(cleanFocus({ panel: "rm -rf", evil: "<script>" }), {}, "an unknown panel and unknown fields are dropped");
  assert.deepEqual(cleanFocus({ path: "../../etc/passwd", line: 3 }), {}, "no climbing out");
  assert.deepEqual(cleanFocus({ path: "C:\\Windows\\x" }), {});
  assert.deepEqual(cleanFocus({ path: "/etc/passwd" }), {});
  assert.deepEqual(cleanFocus({ path: "a\\b.ts" }), { path: "a/b.ts" });
  assert.deepEqual(cleanFocus({ line: 5 }), {}, "a line is only a place inside a file");
  assert.deepEqual(cleanFocus({ path: "a.ts", line: -1 }), { path: "a.ts" });
  assert.deepEqual(cleanFocus({ path: "a.ts", line: 1.5 }), { path: "a.ts" });
  assert.equal(cleanFocus(null), null);
  assert.equal(cleanFocus("files"), null);
  assert.equal(cleanFocus({ lane: "x".repeat(500) })!.lane!.length, 40);
});

test("looking at nothing in particular is a valid thing to say", () => {
  assert.deepEqual(cleanFocus({}), {});
});

test("two places are the same when every part is", () => {
  assert.ok(sameFocus({ panel: "files", path: "a.ts", line: 3 }, { panel: "files", path: "a.ts", line: 3 }));
  assert.ok(sameFocus({}, undefined));
  assert.ok(!sameFocus({ path: "a.ts", line: 3 }, { path: "a.ts", line: 4 }));
  assert.ok(!sameFocus({ lane: "a" }, { lane: "b" }));
  assert.ok(!sameFocus({ path: "a.ts", line: 0 }, { path: "a.ts" }), "line 0 is a line");
});

test("who is on a line", () => {
  const others = { a: { name: "Ann", at: { path: "x.ts", line: 4 } }, b: { name: "Bo", at: { path: "x.ts", line: 5 } }, c: { name: "Cy", at: { path: "y.ts", line: 4 } } };
  assert.deepEqual(watchersOf(others, "x.ts", 4), [{ id: "a", name: "Ann" }]);
  assert.deepEqual(watchersOf(others, "x.ts", 9), []);
});
