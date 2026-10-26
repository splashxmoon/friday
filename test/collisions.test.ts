import assert from "node:assert/strict";
import test from "node:test";
import { collisionLine, collisionsFor, collisionsOf, firstClaim } from "../src/collisions.js";
import { apply, initialState, type SessionState } from "../src/session/projection.js";
import { MAIN_LANE, type EventBody, type SessionEvent } from "../src/types.js";

/**
 * Two lanes writing the same file.
 *
 * The rules that matter are the refusals to cry wolf: one lane editing a file
 * eight times is not a collision, a commit ends every claim because nothing
 * is pending any more, and two lanes touching different files is the normal
 * case that has to stay quiet.
 */

const BUILD = { id: "u-build", name: "Builder", kind: "agent" as const };
const REVIEW = { id: "u-review", name: "Reviewer", kind: "agent" as const };

function fold(rows: [typeof BUILD, string | undefined, EventBody][]): SessionState {
  let s = initialState("s1");
  s.lanes = [
    { id: "l-build", name: "Build" },
    { id: "l-review", name: "Review" },
  ] as SessionState["lanes"];
  rows.forEach(([actor, lane, body], i) => {
    s = apply(s, { seq: i + 1, ts: 1000 + i, actor, body, ...(lane ? { lane } : {}) } as SessionEvent);
  });
  return s;
}

const diff = (...paths: string[]): EventBody => ({
  type: "agent.diff",
  base: "abc",
  files: paths.map((path) => ({ path, status: "modified" as const, additions: 1, deletions: 0, patch: "" })),
});

test("two lanes changing one file is a collision, naming both", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/cart.ts")],
    [REVIEW, "l-review", diff("src/cart.ts")],
  ]);
  const [c] = collisionsOf(s);
  assert.equal(c!.path, "src/cart.ts");
  assert.deepEqual(
    c!.claims.map((x) => x.lane),
    ["l-review", "l-build"],
    "newest first",
  );
  assert.equal(firstClaim(c!).lane, "l-build", "whoever got there first is the one at risk");
});

test("one lane touching a file many times is not a collision with itself", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/cart.ts")],
    [BUILD, "l-build", diff("src/cart.ts")],
    [BUILD, "l-build", { type: "folder.edited", path: "src/cart.ts", bytes: 10 }],
  ]);
  assert.deepEqual(collisionsOf(s), []);
  assert.equal(s.claims.length, 1, "one claim per lane per file");
  assert.equal(s.claims[0]!.seq, 3, "kept current, so the newer of two claims can be named");
});

test("lanes working on different files stay quiet", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/cart.ts")],
    [REVIEW, "l-review", diff("src/checkout.ts")],
  ]);
  assert.deepEqual(collisionsOf(s), []);
});

/** After a commit nothing is pending, so nobody is mid-edit on anything. */
test("committing clears every claim", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/cart.ts")],
    [REVIEW, "l-review", diff("src/cart.ts")],
    [BUILD, undefined, { type: "folder.committed", sha: "a".repeat(40), branch: "main", message: "ship", files: 1 }],
  ]);
  assert.deepEqual(s.claims, []);
  assert.deepEqual(collisionsOf(s), []);
});

test("putting the folder back clears them too", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/cart.ts")],
    [REVIEW, "l-review", diff("src/cart.ts")],
    [BUILD, undefined, { type: "folder.restored", sha: "b".repeat(40), undo: "c".repeat(40), restored: 1, removed: 0 }],
  ]);
  assert.deepEqual(collisionsOf(s), []);
});

test("a person saving a file collides with an agent that wrote it", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/cart.ts")],
    [REVIEW, MAIN_LANE, { type: "folder.edited", path: "src/cart.ts", bytes: 20 }],
  ]);
  assert.equal(collisionsOf(s).length, 1);
  assert.equal(collisionsFor(s, MAIN_LANE).length, 1);
  assert.equal(collisionsFor(s, "l-review").length, 0, "a lane only hears about its own");
});

test("the warning names the other lane, because a count is not something you can go and look at", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/cart.ts")],
    [REVIEW, "l-review", diff("src/cart.ts")],
  ]);
  assert.equal(collisionLine(s, collisionsOf(s)[0]!, "l-build"), "Review has also changed src/cart.ts");
  assert.equal(collisionLine(s, collisionsOf(s)[0]!, "l-review"), "Build has also changed src/cart.ts");
});

test("three lanes on one file reads as a list, not as a number", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/cart.ts")],
    [REVIEW, "l-review", diff("src/cart.ts")],
    [BUILD, MAIN_LANE, diff("src/cart.ts")],
  ]);
  // Asked from a lane's side, that lane is never one of the others.
  assert.equal(collisionLine(s, collisionsOf(s)[0]!, "l-build"), "Main and Review have also changed src/cart.ts");
  assert.equal(collisionLine(s, collisionsOf(s)[0]!, MAIN_LANE), "Review and Build have also changed src/cart.ts");
});

import { buildContext } from "../src/agent/context.js";

/**
 * The warning has to reach the agent, not only the person.
 *
 * A lane's context deliberately excludes every other lane's turns, so an
 * agent about to rewrite a file has no way to know somebody else just
 * rewrote it. This is the one cross-lane fact it is told, and it is told
 * last so trimming a long session never drops it.
 */
test("the agent is told which files another lane has changed, last", () => {
  const msgs = buildContext(
    [{ seq: 1, ts: 1, actor: BUILD, body: { type: "instruction", text: "Fix the cart", interrupt: false, attachments: [] } } as SessionEvent],
    { contended: ["Review has also changed src/cart.ts"] },
  );
  const last = msgs.at(-1)!;
  assert.equal(last.role, "user");
  assert.match(String(last.content), /Review has also changed src\/cart\.ts/);
  assert.match(String(last.content), /Re-read a file before you rewrite it/);
});

test("nothing is added when no two lanes overlap", () => {
  const ev = [{ seq: 1, ts: 1, actor: BUILD, body: { type: "instruction", text: "Fix the cart", interrupt: false, attachments: [] } } as SessionEvent];
  assert.equal(JSON.stringify(buildContext(ev, { contended: [] })), JSON.stringify(buildContext(ev)));
});

test("two agents in two different repositories changing the same path don't collide; in one repo, or a copy of it, they do", () => {
  const s = fold([
    [BUILD, "l-build", diff("src/index.ts")],
    [REVIEW, "l-review", diff("src/index.ts")],
  ]);
  const engine = (cwd: string, extra: object = {}) => ({ tool: "claude", hostId: "h", hostName: "Ada", cwd, mode: "edits", online: true, ...extra }) as unknown as SessionState["engines"][string];
  s.engines = { "l-build": engine("C:/code/shop"), "l-review": engine("C:/code/blog") };
  assert.equal(collisionsFor(s, "l-build").length, 0, "different folders, different files");
  s.engines["l-review"] = engine("C:/Users/ada/.friday/copies/shop-1", { copyOf: "C:\\code\\shop\\" });
  assert.equal(collisionsFor(s, "l-build").length, 1, "a separate copy of the same folder meets it again when brought over");
  delete s.engines["l-review"];
  assert.equal(collisionsFor(s, "l-build").length, 1, "a lane with no folder of its own works in the main one's, or isn't known: counted in");
});
