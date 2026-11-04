import assert from "node:assert/strict";
import test from "node:test";
import { onOwnChange } from "../src/client/page-keep.js";

/** A Storage as browsers have it, in memory. */
class Mem implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

// The page's settings were kept beside the data only every fifteen seconds, so size and fonts changed a few seconds before a quit
// were gone after the restart (2026-11-04 retest). A change to one of the page's own keys is now said at once, to be sent soon.
test("a change to one of the page's own settings is noticed as it is made, nobody else's", () => {
  const s = new Mem();
  let n = 0;
  const undo = onOwnChange(s, () => n++);
  s.setItem("mpa.textSize", "15");
  assert.equal(s.getItem("mpa.textSize"), "15");
  assert.equal(n, 1);
  s.setItem("friday.panelWidth", "420");
  s.removeItem("mpa.fonts");
  assert.equal(n, 3);
  // Not another app's key, nor a reload's own bookkeeping.
  s.setItem("someone.else", "x");
  s.setItem("mpa.chunkReloadAt", "1");
  s.setItem("friday.pageKept", "http://127.0.0.1:4321");
  assert.equal(n, 3);
  undo();
  s.setItem("mpa.theme", "dark");
  assert.equal(n, 3);
});
