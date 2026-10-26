import assert from "node:assert/strict";
import { test } from "node:test";

/** A tab's own storage, as the page has it. */
const store = new Map<string, string>();
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as Storage;

const { askToShowDiff, clearDiffRequest, readDiffRequest, sameFile } = await import("../src/client/focusDiff.js");

test("a request to show a file's diff is for one session, and lapses", () => {
  store.clear();
  askToShowDiff("s1", ".github/workflows/ci.yml");
  assert.equal(readDiffRequest("s1"), ".github/workflows/ci.yml");
  assert.equal(readDiffRequest("s2"), null, "another session does not take it");
  assert.equal(readDiffRequest("s1", Date.now() + 25_000), null, "and it does not open a panel by surprise later");
  clearDiffRequest();
  assert.equal(readDiffRequest("s1"), null);
});

test("garbage in storage is no request", () => {
  store.set("mpa.focusDiff", "{nope");
  assert.equal(readDiffRequest("s1"), null);
  store.set("mpa.focusDiff", JSON.stringify({ sid: "s1", path: 5, at: Date.now() }));
  assert.equal(readDiffRequest("s1"), null);
});

test("a file is the same file whether named from the root or a level below", () => {
  assert.ok(sameFile("src/app.ts", "src/app.ts"));
  assert.ok(sameFile("svc/src/app.ts", "src/app.ts"));
  assert.ok(sameFile("src/app.ts", "svc/src/app.ts"));
  assert.ok(!sameFile("src/app.ts", "src/other.ts"));
  assert.ok(!sameFile("xsrc/app.ts", "src/app.ts"), "a partial name is not a path");
});
