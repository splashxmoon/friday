import assert from "node:assert/strict";
import test from "node:test";
import { keptPlan, onOwnChange } from "../src/client/page-keep.js";

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

// Friday on another port for a while (4321 taken), then on 4321 again: 4321's page went back to what it had before, so a setting
// changed meanwhile was lost and What's new, put away on the other port, showed again (2026-11-04 update check).
test("an address Friday comes back to takes a copy kept after its own, and only then", () => {
  const kept = (origin: string, at: number) => ({ origin, at, keys: { "friday.whatsNew.shown": "0.2.12" } });
  const here = { origin: "http://127.0.0.1:4321", marked: true, keptAt: 1_000 };
  assert.equal(keptPlan(here, kept("http://127.0.0.1:60043", 2_000)), "take", "newer, from the other port: its values win");
  assert.equal(keptPlan(here, kept("http://127.0.0.1:60043", 500)), "none", "older than this address's own: kept as it is");
  assert.equal(keptPlan(here, kept("http://127.0.0.1:4321", 2_000)), "none", "its own copy");
  assert.equal(keptPlan({ ...here, marked: false, keptAt: 0 }, kept("http://127.0.0.1:60043", 2_000)), "fill", "a new address fills in what it lacks");
  assert.equal(keptPlan({ ...here, keptAt: 0 }, kept("http://127.0.0.1:60043", 2_000)), "take", "an address from before this was kept takes the copy");
  assert.equal(keptPlan(here, null), "none");
  assert.equal(keptPlan(here, { origin: "http://127.0.0.1:60043", at: 2_000, keys: {} }), "none", "an empty copy changes nothing");
});
