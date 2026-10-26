import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The page's window, as far as the show-diff ask needs one: something to dispatch on.
(globalThis as unknown as { window: EventTarget }).window = new EventTarget();
const { showDiffSoon, takesShowDiff } = await import("../src/client/focusDiff.js");

/** A Diff panel's DiffView for `path`, as its listener answers: counts what it did. */
function diffView(path: string) {
  const did = { scroll: 0, flash: 0 };
  const el = { closest: (sel: string) => (sel === ".bench-body" ? {} : null) } as unknown as Element;
  const on = (e: Event) => {
    if (!takesShowDiff(e, path, el)) return;
    did.scroll++;
    did.flash++;
  };
  return { did, mount: () => window.addEventListener("friday:show-diff", on), unmount: () => window.removeEventListener("friday:show-diff", on) };
}

/** Every show-diff asked, taken or not. */
function asks() {
  const n = { count: 0 };
  const on = () => n.count++;
  window.addEventListener("friday:show-diff", on);
  return { n, stop: () => window.removeEventListener("friday:show-diff", on) };
}

test("show-diff is answered exactly once, and the asking stops there", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const view = diffView("src/p.ts");
  const other = diffView("src/p.ts"); // a second copy (a Files panel kept from earlier) does not answer again
  view.mount();
  other.mount();
  const seen = asks();
  t.after(() => [view.unmount(), other.unmount(), seen.stop()]);
  showDiffSoon("svc/src/p.ts");
  mock.timers.tick(2200);
  assert.deepEqual(view.did, { scroll: 1, flash: 1 });
  assert.deepEqual(other.did, { scroll: 0, flash: 0 });
  assert.equal(seen.n.count, 1, "the tries after the first answered one were cleared");
});

test("a Diff panel that draws late, before the 900ms try, still answers exactly once", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const view = diffView("src/p.ts");
  const seen = asks();
  t.after(() => [view.unmount(), seen.stop()]);
  showDiffSoon("src/p.ts");
  setTimeout(view.mount, 600);
  mock.timers.tick(2200);
  assert.deepEqual(view.did, { scroll: 1, flash: 1 });
  assert.equal(seen.n.count, 2, "asked at 350ms with nobody there, taken at 900ms, not asked at 1700ms");
});
