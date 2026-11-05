import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { stallGuard } from "../src/update-stall.js";

/**
 * An app update whose download stops moving without an error (desktop-update.ts). electron-updater's requests go through
 * Electron's net, where its socket timeout never applies, so a download cut off by sleep or a network change could sit at
 * "downloading" for good, and check() then never asked again. The guard ends it after a quiet spell, so the next check starts over.
 */
test("a download that goes quiet is called stalled once, after the quiet spell", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let stalls = 0;
    const g = stallGuard(120_000, () => stalls++);
    g.poke();
    mock.timers.tick(100_000);
    g.poke(); // progress
    mock.timers.tick(100_000);
    assert.equal(stalls, 0);
    mock.timers.tick(20_001);
    assert.equal(stalls, 1);
    mock.timers.tick(500_000);
    assert.equal(stalls, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a download that finishes or fails is never called stalled", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let stalls = 0;
    const g = stallGuard(1000, () => stalls++);
    g.poke();
    g.stop();
    mock.timers.tick(5000);
    assert.equal(stalls, 0);
  } finally {
    mock.timers.reset();
  }
});
