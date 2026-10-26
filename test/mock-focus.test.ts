import assert from "node:assert/strict";
import { test } from "node:test";
import { placesFor } from "../src/mock-focus.js";
import { project } from "../src/session/projection.js";
import type { SessionEvent } from "../src/types.js";

const log: SessionEvent[] = [
  { seq: 1, ts: 1, actor: { id: "system", name: "System", kind: "system" } as SessionEvent["actor"], body: { type: "session.created", title: "t", ownerId: "ada", ownerName: "Ada" } },
  {
    seq: 2,
    ts: 2,
    actor: { id: "a", name: "A", kind: "agent" } as SessionEvent["actor"],
    body: { type: "agent.diff", base: "x", files: [{ path: ".github/workflows/ci.yml", status: "modified", additions: 8, deletions: 0, patch: "@@ -10,2 +12,9 @@\n a\n+b\n" }, { path: "src/db.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,3 +1,3 @@\n" }] } as never,
  },
];

test("people in a mock take turns being in different places, and stay inside the session", () => {
  const state = project("s", log);
  const seen = new Set<string>();
  for (let step = 0; step < 24; step++) {
    for (const who of [0, 1, 2]) {
      const at = placesFor(state, who, step);
      assert.equal(at.lane, "main", "a session with one agent has one chat");
      if (at.path) assert.ok(["src/db.ts", ".github/workflows/ci.yml"].includes(at.path));
      if (at.line !== undefined) {
        assert.ok(at.path, "a line is only a line of a file");
        if (at.path === ".github/workflows/ci.yml") assert.ok(at.line >= 12 && at.line <= 20, `a line inside the diff, got ${at.line}`);
      }
      seen.add(JSON.stringify(at));
    }
  }
  assert.ok(seen.size > 6, "they do not all stand in one place");
  assert.notDeepEqual(placesFor(state, 0, 3), placesFor(state, 1, 3), "two people are not in the same place at once");
});

test("with nothing changed there is still somewhere to be", () => {
  const at = placesFor(project("s", log.slice(0, 1)), 0, 1);
  assert.equal(at.path, undefined);
  assert.ok(at.lane);
});
