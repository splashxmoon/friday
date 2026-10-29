// Crew: the teammates' faces, Friday's own round blobs (Arun, 2026-10-29: "those avatars should be purely circle based with
// different morphed shapes").
import assert from "node:assert/strict";
import test from "node:test";
import { lookOf, outline, shapeOf } from "../src/client/teammate-face.js";

/** The outline's points: each Bézier's end point (the curve passes through every sample). */
const points = (d: string) => [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)(?=C|Z)/g)].map((m) => [+m[1]!, +m[2]!] as const).slice(1);

test("a face is the same for the same seed, and a shuffled seed gives another", () => {
  assert.equal(shapeOf("Nova").still, shapeOf("Nova").still);
  assert.deepEqual(lookOf("Nova"), lookOf("Nova"));
  assert.notEqual(shapeOf("Nova").still, shapeOf("Nova-2").still, "Shuffle look changes the seed, and so the shape");
  const many = new Set(["Ines", "Theo", "Rafa", "Quinn", "Nova", "Kit", "Juno", "Ada Park"].map((s) => shapeOf(s).still));
  assert.equal(many.size, 8, "every teammate a silhouette of its own");
});

test("every face is round: a smooth closed curve, its widest point on the box's circle and never far inside it", () => {
  for (const seed of ["Ines", "Theo", "Rafa", "Quinn", "Nova", "Kit", "Juno", "x", "", "Friday-k3x9q", "长名字"]) {
    const d = shapeOf(seed).still;
    assert.match(d, /^M[^LHV]*Z$/, "curves only: no straight line, so no corner");
    const r = points(d).map(([x, y]) => Math.hypot(x, y));
    assert.equal(r.length, 48);
    assert.ok(Math.abs(Math.max(...r) - 50) < 0.05, `${seed}: its widest point touches the ring's circle`);
    assert.ok(Math.min(...r) > 50 * 0.8, `${seed}: morphed, never squashed (narrowest ${Math.min(...r).toFixed(1)})`);
  }
});

test("a working face's breath stays within its circle at every step, and comes back to where it started", () => {
  const { still, breathing } = shapeOf("Theo");
  const frames = breathing.split(";");
  assert.equal(frames.length, 4);
  assert.equal(frames[0], still);
  assert.equal(frames[3], still);
  for (const f of frames) {
    const r = points(f).map(([x, y]) => Math.hypot(x, y));
    assert.equal(r.length, 48, "the same number of points, so the outline can be eased from one to the next");
    assert.ok(Math.max(...r) <= 50.05);
  }
  // A plain circle is a circle.
  const circle = points(outline([])).map(([x, y]) => Math.hypot(x, y));
  assert.ok(circle.every((v) => Math.abs(v - 50) < 0.05));
});
