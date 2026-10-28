import assert from "node:assert/strict";
import test from "node:test";
import { lanesToReattach, reattachParams, recentEnough, REATTACH_WINDOW_MS } from "../src/reattach.js";
import type { LaneEngine, SessionState } from "../src/session/projection.js";
import { MAIN_LANE } from "../src/types.js";

/**
 * A computer linking brings back the lanes its coding tools held and lost (reattach.ts): its own offline lanes with a folder,
 * never a teammate's, never one that is online, never one with nowhere to come back to.
 */

const engine = (over: Partial<LaneEngine>): LaneEngine => ({ tool: "codex", hostId: "ada", hostName: "Ada's Mac", cwd: "/Users/ada/app", mode: "full", online: false, sinceSeq: 7, ...over });

test("only this computer's offline lanes with a folder come back, main lane first", () => {
  const state = {
    lanes: [{ id: "l1" }, { id: "l2" }, { id: "l3" }, { id: "l4" }],
    engines: {
      [MAIN_LANE]: engine({}),
      l1: engine({ online: true }),
      l2: engine({ hostId: "ben", hostName: "Ben's PC" }),
      l3: engine({ cwd: "" }),
      l4: engine({ tool: "claude", model: "opus", account: { id: "work", label: "Work" }, copyOf: "/Users/ada/app", handMode: "edits" }),
    },
  } as unknown as SessionState;
  const lanes = lanesToReattach(state, "ada");
  assert.deepEqual(lanes.map((l) => l.lane), [MAIN_LANE, "l4"]);
  assert.deepEqual(reattachParams("s1", "inv", "l4", lanes[1]!.engine, "tok"), {
    sid: "s1",
    invite: "inv",
    actorToken: "tok",
    tool: "claude",
    cwd: "/Users/ada/app",
    mode: "full",
    handMode: "edits",
    lane: "l4",
    model: "opus",
    account: "work",
    copyOf: "/Users/ada/app",
    ifOffline: true,
  });
  // A lane sharing its folder with another by choice comes back sharing it.
  assert.equal(reattachParams("s1", "inv", "l5", engine({ shared: true }), "tok").share, true);
  assert.equal(reattachParams("s1", "inv", "l5", engine({}), "tok").share, undefined);
  // A lent folder with no tool behind it is nobody's to bring back.
  assert.deepEqual(lanesToReattach({ lanes: [], engines: { [MAIN_LANE]: engine({ tool: undefined }) } } as unknown as SessionState, "ada"), []);
});

test("sessions untouched for a week wait to be opened", () => {
  const now = 1_000_000_000_000;
  assert.ok(recentEnough(now - REATTACH_WINDOW_MS + 1, now));
  assert.ok(!recentEnough(now - REATTACH_WINDOW_MS - 1, now));
});
