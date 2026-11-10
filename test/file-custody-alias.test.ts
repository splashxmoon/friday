import assert from "node:assert/strict";
import test from "node:test";
import { heldBy } from "../src/agent-mesh.js";
import type { SessionState } from "../src/session/projection.js";

const state = (claimed: string): SessionState =>
  ({
    lanes: [{ id: "alpha", name: "Alpha" }],
    engines: {},
    options: {},
    holds: { alpha: { paths: [claimed], seq: 7 } },
  }) as unknown as SessionState;

test("a claim saved under another spelling of the same file still holds it, and a path out of the project holds nothing", () => {
  const held = state("src/../src/a.ts");
  assert.deepEqual(heldBy(held, "beta", "src/a.ts").map((x) => x.lane), ["alpha"]);
  assert.deepEqual(heldBy(held, "beta", "./src/a.ts").map((x) => x.lane), ["alpha"]);
  assert.deepEqual(heldBy(held, "beta", "src/b.ts"), [], "disjoint file remains free");
  assert.deepEqual(heldBy(held, "beta", "../src/a.ts"), [], "outside-root claims have no custody");
});

test("a folder claimed under another spelling holds what is in it, and nothing beside it", () => {
  const held = state("src/tmp/../components/");
  assert.deepEqual(heldBy(held, "beta", "src/components/button.ts").map((x) => x.lane), ["alpha"]);
  assert.deepEqual(heldBy(held, "beta", "src/other/button.ts"), []);
});
