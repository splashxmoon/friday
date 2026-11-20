import assert from "node:assert/strict";
import { test } from "node:test";

// Session restore on the page (Arun, 2026-11-19, wave 4): where a chat was scrolled to, and which folder Code opens on.
const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = store();
g.sessionStorage = store();

interface Row {
  dataset: { seq: string };
  getBoundingClientRect: () => { top: number; bottom: number };
}
/** A scroll box of rows 100 tall, each with a seq, scrolled by `top` inside a box 300 tall. */
function box(top: number, rows = 10) {
  const el = {
    scrollTop: top,
    clientHeight: 300,
    get scrollHeight() {
      return rows * 100;
    },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () =>
      Array.from({ length: rows }, (_, i): Row => ({ dataset: { seq: String(i + 1) }, getBoundingClientRect: () => ({ top: i * 100 - el.scrollTop, bottom: i * 100 + 100 - el.scrollTop }) })),
    querySelector: (q: string) => {
      const n = Number(/data-seq="(\d+)"/.exec(q)?.[1]);
      return n >= 1 && n <= rows ? { getBoundingClientRect: () => ({ top: (n - 1) * 100 - el.scrollTop }) } : null;
    },
  };
  return el as unknown as HTMLElement;
}

test("a chat scrolled up is read as its first row on screen, and put back to the same place", async () => {
  const { readPlace, putPlace } = await import("../src/client/ide/restore.js");
  const a = box(250);
  const p = readPlace(a)!;
  assert.equal(p.seq, 3, "row 3 is the first with any of it on screen");
  assert.equal(p.off, -50);
  const b = box(0);
  assert.equal(putPlace(b, p), true);
  assert.equal(b.scrollTop, 250);
});

test("a chat at its end has no place to put back", async () => {
  const { readPlace } = await import("../src/client/ide/restore.js");
  assert.equal(readPlace(box(700)), null, "1000 tall, 300 shown: 700 is the end");
  assert.equal(readPlace(box(690)), null, "within a few pixels of it");
});

test("a place is kept, replaced and forgotten by chat", async () => {
  const { rememberPlace, placeOf } = await import("../src/client/ide/restore.js");
  rememberPlace("s1", { seq: 4, off: -10, top: 290 });
  assert.equal(placeOf("s1")?.seq, 4);
  assert.match(String((globalThis as unknown as { localStorage: Storage }).localStorage.getItem("friday.code.scroll")), /"s1"/);
  rememberPlace("s1", null);
  assert.equal(placeOf("s1"), null);
});

test("a place whose row is not drawn yet is not put back, so the feed is asked again", async () => {
  const { putPlace } = await import("../src/client/ide/restore.js");
  assert.equal(putPlace(box(0, 3), { seq: 9, off: 0, top: 800 }), false);
});

test("Code opens on this window's folder, else the last one kept, and a choice changes both", async () => {
  g.sessionStorage = store();
  g.localStorage = store();
  (g.localStorage as Storage).setItem("friday.ide.last", "/work/last");
  const m = await import("../src/client/ide/mode.js");
  assert.equal(m.restoredIdeRoot(), "/work/last", "a launch starts from the last one");
  assert.equal(m.getIdeRoot(), null, "held back until the check answers");
  m.releaseRestoredRoot();
  assert.equal(m.getIdeRoot(), "/work/last");
  m.setIdeRoot("/work/new");
  assert.equal(m.restoredIdeRoot(), null, "a choice is not a restored folder");
  assert.equal((g.localStorage as Storage).getItem("friday.ide.last"), "/work/new");
  m.setIdeRoot(null);
  assert.equal((g.localStorage as Storage).getItem("friday.ide.last"), null, "closing the folder forgets it");
});
