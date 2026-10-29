import assert from "node:assert/strict";
import test from "node:test";

// Unsaved work asks before it is left, by any way out (QA, 2026-10-28: a workflow's unsaved steps went without a word when the
// sidebar, a toast or Back took the person elsewhere).
const listeners = new Map<string, Set<unknown>>();
const pushed: string[] = [];
let backs = 0;
Object.assign(globalThis, {
  location: { href: "http://x/?p=automations" },
  addEventListener: (t: string, f: unknown) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
  removeEventListener: (t: string, f: unknown) => void listeners.get(t)?.delete(f),
  history: { pushState: (_: unknown, __: string, url: string) => void pushed.push(url), back: () => void backs++ },
});
const { holdLeave, leaving, leavingByHistory } = await import("../src/client/leave-guard.js");

test("nothing held: every way out goes at once", () => {
  assert.equal(leaving(() => {}), false);
  assert.equal(leavingByHistory(), false);
});

test("held: the screen asks, and only a yes goes; the hold is let go then", () => {
  let asked: (() => void) | null = null;
  const release = holdLeave((go) => void (asked = go));
  assert.equal(listeners.get("beforeunload")?.size, 1, "closing the window asks too");
  let went = 0;
  assert.equal(leaving(() => went++), true);
  assert.equal(went, 0);
  asked!();
  assert.equal(went, 1);
  assert.equal(leaving(() => went++), false, "let go once agreed");
  release();
  assert.equal(listeners.get("beforeunload")?.size, 0);
});

test("Back while held puts the address back, and goes back again only once agreed", () => {
  let asked: (() => void) | null = null;
  const release = holdLeave((go) => void (asked = go));
  assert.equal(leavingByHistory(), true);
  assert.deepEqual(pushed, ["http://x/?p=automations"]);
  assert.equal(backs, 0);
  asked!();
  assert.equal(backs, 1);
  release();
});
