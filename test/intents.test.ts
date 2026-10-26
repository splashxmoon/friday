import assert from "node:assert/strict";
import test from "node:test";
import { plannedOverlapLine, plannedOverlapsFor } from "../src/collisions.js";
import { pathsIn, project } from "../src/session/projection.js";
import type { SessionEvent } from "../src/types.js";

/** Agents saying which files they'll change, read from their plans, and overlaps found before either writes (intents). */

test("the files a plan names, however it writes them, and not version numbers or prose", () => {
  assert.deepEqual(pathsIn("1. Edit src/cart.ts\n2. update `Sources/App/Cart.swift` and ./README.md (docs)\n3. bump to 2.4.1"), ["src/cart.ts", "Sources/App/Cart.swift", "README.md"]);
  assert.deepEqual(pathsIn('{"steps":[{"step":"Fix rounding in lib/money.ts","status":"pending"}]}'), ["lib/money.ts"]);
  assert.deepEqual(pathsIn("Think about the checkout flow"), []);
});

const at = (seq: number, body: SessionEvent["body"], lane?: string): SessionEvent => ({ seq, ts: seq, actor: { id: "a", name: "Agent", kind: "agent" }, body, ...(lane ? { lane } : {}) }) as SessionEvent;
const plan = (seq: number, steps: string[], lane?: string) => at(seq, { type: "agent.message", text: "", toolCalls: [{ id: `p${seq}`, name: "update_plan", arguments: JSON.stringify({ steps: steps.map((s) => ({ step: s, status: "pending" })) }) }] }, lane);

test("one agent's plan names a file another is changing or plans to: both see it, before anyone writes", () => {
  const s = project("s", [
    at(1, { type: "session.created", title: "t", ownerId: "o", ownerName: "O" }),
    at(2, { type: "lane.added", lane: { id: "lc", name: "Codex", agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } } as never),
    plan(3, ["Rewrite totals in src/cart.ts", "Add a test in test/cart.test.ts"]),
    plan(4, ["Change the currency format in src/cart.ts"], "lc"),
  ]);
  const mine = plannedOverlapsFor(s, "lc");
  assert.deepEqual(mine, [{ path: "src/cart.ts", with: ["Main"] }]);
  assert.deepEqual(plannedOverlapsFor(s, "main").map((o) => o.path), ["src/cart.ts"]);
  assert.match(plannedOverlapLine(mine[0]!), /Main is also working on src\/cart\.ts: coordinate/);
});

test("a commit clears what was planned, along with what was changed", () => {
  const s = project("s", [
    at(1, { type: "session.created", title: "t", ownerId: "o", ownerName: "O" }),
    plan(2, ["Edit src/a.ts"]),
    at(3, { type: "folder.committed", message: "m", branch: "b", files: 1 } as never),
  ]);
  assert.deepEqual(s.intents, {});
});
