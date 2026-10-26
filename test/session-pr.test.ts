import assert from "node:assert/strict";
import test from "node:test";
import { prOf } from "../src/attention.js";
import { apply, initialState } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const HUMAN = { id: "u1", name: "Arun", kind: "human" as const };
let seq = 0;
const ev = (body: EventBody, actor: SessionEvent["actor"] = HUMAN): SessionEvent => ({ seq: ++seq, ts: 1_700_000_000_000 + seq, actor, body }) as SessionEvent;

test("the session remembers the pull request its commit opened, and that a shepherded one merged, for the sidebar to settle it", () => {
  let s = initialState("s1");
  s = apply(s, ev({ type: "session.created", title: "t", ownerId: "u1", ownerName: "Arun" } as EventBody));
  assert.equal(prOf(s), null);
  s = apply(s, ev({ type: "folder.committed", files: 2, message: "Fix it", branch: "fix", pushed: true, prUrl: "https://github.com/acme/app/pull/12", prCreated: true } as EventBody));
  assert.deepEqual(prOf(s), { sid: "s1", url: "https://github.com/acme/app/pull/12", merged: false });
  s = apply(s, ev({ type: "pr.shepherd", on: true, prUrl: "https://github.com/acme/app/pull/12" } as EventBody));
  s = apply(s, ev({ type: "pr.shepherd.ended", outcome: "merged", text: "Merged." } as EventBody));
  assert.deepEqual(prOf(s), { sid: "s1", url: "https://github.com/acme/app/pull/12", merged: true });
  // A commit without a pull request leaves it; a commit to a different pull request replaces it.
  s = apply(s, ev({ type: "folder.committed", files: 1, message: "More", branch: "fix" } as EventBody));
  assert.equal(prOf(s)?.merged, true);
  s = apply(s, ev({ type: "folder.committed", files: 1, message: "Next", branch: "next", prUrl: "https://github.com/acme/app/pull/13" } as EventBody));
  assert.deepEqual(prOf(s), { sid: "s1", url: "https://github.com/acme/app/pull/13", merged: false });
});
