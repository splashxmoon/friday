import assert from "node:assert/strict";
import test from "node:test";
import { fitAllZoom } from "../src/client/TeamWorkflows.js";

// "Fit it in view" only reset the canvas to its own zoom, never under 60%, so a five-step workflow still ran past the right edge
// (2026-11-04 retest). It now fits the whole line across the view.
test("Fit it in view shows the whole line, however wide, down to 30%", () => {
  // 1000px of view, a line 2000px wide: the canvas sits at 60%, which shows 1600px; fitting takes it to 47.6%.
  const fit = 0.6;
  const z = fitAllZoom(1000, 2000, fit);
  assert.ok(z * fit * 2000 <= 1000 - 48 + 1, `fits: ${z * fit * 2000}`);
  assert.equal(+(z * fit).toFixed(3), 0.476);
  // One that already fits stays as it is; a vast one stops at 30%.
  assert.equal(fitAllZoom(1600, 900, 1), 1);
  assert.equal(+(fitAllZoom(1000, 9000, 0.6) * 0.6).toFixed(2), 0.3);
});
