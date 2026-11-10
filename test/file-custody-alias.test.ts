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

test("S2 file custody recognizes an equivalent in-root alias from a persisted claim", () => {
  const held = state("src/../src/a.ts");
  assert.deepEqual(heldBy(held, "beta", "src/a.ts").map((x) => x.lane), ["alpha"]);
  assert.deepEqual(heldBy(held, "beta", "./src/a.ts").map((x) => x.lane), ["alpha"]);
  assert.deepEqual(heldBy(held, "beta", "src/b.ts"), [], "disjoint file remains free");
  assert.deepEqual(heldBy(held, "beta", "../src/a.ts"), [], "outside-root claims have no custody");
});

test("S2 directory custody includes in-root aliases but not unrelated paths", () => {
  const held = state("src/tmp/../components/");
  assert.deepEqual(heldBy(held, "beta", "src/components/button.ts").map((x) => x.lane), ["alpha"]);
  assert.deepEqual(heldBy(held, "beta", "src/other/button.ts"), []);
});
