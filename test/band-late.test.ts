// The desktop window's band arrives after the page has opened (its stylesheet goes in once the page has loaded): a page opened by
// a reload asked for it too early and laid out as in a browser, 12px lower than the same page reached from another (audit e2e,
// Arun 2026-11-04). onBand (ui.tsx) runs its work when the band comes, and never in a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./fake-dom.js";

const { onBand } = await import("../src/client/ui.js");
const g = globalThis as Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let band = "";
g.getComputedStyle = () => ({ getPropertyValue: (k: string) => (k === "--band" ? band : "") });

test("in a browser: never, and nothing waits", async () => {
  let ran = 0;
  const off = onBand(() => void ran++);
  await sleep(80);
  assert.equal(ran, 0);
  off();
});

test("in the desktop window: when the band comes, once, and undone with the page", async () => {
  g.fridayDesktop = { platform: "darwin" };
  let ran = 0;
  let undone = 0;
  const off = onBand(() => {
    ran++;
    return () => void undone++;
  });
  assert.equal(ran, 0, "not before the window's stylesheet is in");
  band = "40px";
  await sleep(220);
  assert.equal(ran, 1, "as soon as it is");
  await sleep(500);
  assert.equal(ran, 1, "and only once");
  off();
  assert.equal(undone, 1);
  // Once the band has been seen, a page opening after runs at once.
  let now = 0;
  onBand(() => void now++)();
  assert.equal(now, 1);
  delete g.fridayDesktop;
});
