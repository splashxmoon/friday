import assert from "node:assert/strict";
import test from "node:test";

/** A session's terminal tabs are kept until they are closed, and what was kept is read back carefully. */

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { savedTabs, saveTabs } = await import("../src/client/Terminal.js");

test("a session's tabs come back as they were left, which one showing included", () => {
  saveTabs("s1", ["ta-0", "tb-1"], 1);
  assert.deepEqual(savedTabs("s1"), { ids: ["ta-0", "tb-1"], at: 1 });
  assert.equal(savedTabs("s2"), null, "another session's are its own");
});

test("what was kept is read back carefully: bad ids dropped, the showing one kept in range, junk ignored", () => {
  store.set("friday.terms.s3", JSON.stringify({ ids: ["ok-1", 7, "bad id!", "ok-2"], at: 9 }));
  assert.deepEqual(savedTabs("s3"), { ids: ["ok-1", "ok-2"], at: 1 });
  store.set("friday.terms.s4", "{not json");
  assert.equal(savedTabs("s4"), null);
  store.set("friday.terms.s5", JSON.stringify({ ids: [] }));
  assert.equal(savedTabs("s5"), null, "no tabs is no record: the panel starts one");
});
