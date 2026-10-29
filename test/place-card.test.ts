// Where a floating card goes (ui.tsx placeCard): the side that holds all of it, pinned by one edge with the other let go, and
// placed in the page's own pixels when Settings › Interface size zooms the page (Arun, 2026-10-28: "TEST EVERYTHING… EVERY
// INTERACTION, EVERY VISUAL").
import assert from "node:assert/strict";
import { test } from "node:test";
import "./fake-dom.js";

const g = globalThis as Record<string, unknown>;
let zoom = "1";
g.getComputedStyle = () => ({ zoom });
g.innerWidth = 1500;
g.innerHeight = 950;
const { placeCard, uiZoom } = await import("../src/client/ui.js");

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

test("a menu low in a list opens upwards when only the space above holds all of it", () => {
  // 373px under the row, 560 over it, and a menu 440 tall: below it would scroll.
  const p = placeCard(rect(20, 560, 200, 30), 260, { want: 440, min: 180, gap: 4 });
  assert.equal(p.top, "auto");
  assert.equal(p.bottom, 950 - 560 + 4);
  assert.equal(p.maxHeight, 440);
});

test("below while below holds it all, and the edge it isn't pinned by is let go", () => {
  const p = placeCard(rect(20, 100, 200, 30), 260, { want: 300, min: 180, gap: 4 });
  assert.equal(p.top, 134);
  assert.equal(p.bottom, "auto");
});

test("neither side holds it: the roomier one, never shorter than its minimum", () => {
  const p = placeCard(rect(20, 560, 200, 30), 260, { want: 900, min: 180, gap: 4 });
  assert.equal(p.top, "auto");
  assert.equal(p.maxHeight, 560 - 4 - 8);
  const q = placeCard(rect(20, 300, 200, 30), 260, { want: 900, min: 180, gap: 4 });
  assert.equal(q.bottom, "auto");
  assert.equal(q.maxHeight, 950 - 330 - 4 - 8);
});

test("an upward card from a control at the window's foot (the status bar's branch card) has top let go", () => {
  const p = placeCard(rect(470, 930, 120, 20), 300, { want: 360, min: 160, prefer: "below" });
  assert.equal(p.top, "auto");
  assert.equal(typeof p.bottom, "number");
});

test("end lines the card's right edge up with the anchor's", () => {
  const p = placeCard(rect(1000, 100, 40, 30), 300, { want: 200, end: true });
  assert.equal(p.left + p.width, 1040);
});

test("at Larger interface size the card is placed in the page's pixels", () => {
  zoom = "1.2";
  try {
    assert.equal(uiZoom(), 1.2);
    // The button measured at 1200..1240 in the window is at 1000..1033 in the zoomed page, whose width is 1250.
    const p = placeCard(rect(1200, 120, 40, 36), 280, { want: 300, end: true });
    assert.ok(Math.abs(p.left + p.width - 1240 / 1.2) < 0.01);
    assert.ok(p.left + p.width <= 1500 / 1.2 - 8);
    assert.ok(Math.abs((p.top as number) - (156 / 1.2 + 6)) < 0.01);
    // Never past the zoomed window's right edge, however far right the anchor.
    const q = placeCard(rect(1480, 120, 10, 10), 400, { want: 300 });
    assert.ok(q.left + q.width <= 1500 / 1.2 - 8 + 0.01);
  } finally {
    zoom = "1";
  }
});
