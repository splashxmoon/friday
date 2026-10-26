import assert from "node:assert/strict";
import test from "node:test";
import { doneVerdict, explainRun } from "../src/explain.js";
import { prBodyFor } from "../src/pr-body.js";
import { project } from "../src/session/projection.js";
import type { DiffFile, EventBody, SessionEvent } from "../src/types.js";

/**
 * Trust: the reasons people stay.
 *
 * The diff is explained before it is shown, in three sentences read from the log. "Done" carries one word about
 * whether anything checked it. And a pull request carries a "Verified by Friday" block with a recording anyone can
 * open, so reviewers who have never used Friday can see the run for themselves.
 */

const file = (path: string, additions: number, deletions: number, status: DiffFile["status"] = "modified"): DiffFile => ({ path, status, additions, deletions, patch: "" });

test("the diff in three sentences: what changed, why, and where to look first", () => {
  const files = [file("src/session/core.ts", 40, 12), file("src/session/store.ts", 6, 1), file("test/core.test.ts", 30, 0, "added")];
  const lines = explainRun({ files, ask: { who: "Priya", text: "Make commits record who pushed them." }, decided: ["Keep the sha on the event, not the member."], flags: [], tests: "pass" });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Changed 3 files (+76 −13), mostly under src/session; 1 new.");
  assert.equal(lines[1], "Because Priya asked: “Make commits record who pushed them”. On the way it decided: Keep the sha on the event, not the member.");
  assert.equal(lines[2], "Start with src/session/core.ts, the biggest change (+40 −12); the tests passed.");

  // A flag is the first thing to look at, ahead of any size.
  const flagged = explainRun({ files, flags: [{ level: "bad", text: "Switched off a test in test/core.test.ts" }], tests: "none" });
  assert.equal(flagged.length, 2, "nothing to say about why when nobody asked");
  assert.equal(flagged[1], "Look here first: Switched off a test in test/core.test.ts.");

  assert.deepEqual(explainRun({ files: [file("README.md", 2, 2)], tests: "none" }), ["Changed README.md (+2 −2).", "Nothing else moved; no tests ran."]);
  assert.deepEqual(explainRun({ files: [] }), []);
});

test("done means one thing: checked, failed, or unverified; and nothing when nothing changed", () => {
  assert.deepEqual(doneVerdict(3, "pass"), { text: "Done · tests passed", tone: "pass" });
  assert.deepEqual(doneVerdict(3, "fail"), { text: "Done · tests failed", tone: "fail" });
  assert.deepEqual(doneVerdict(3, null), { text: "Done · unverified", tone: "none" });
  assert.equal(doneVerdict(0, "pass"), null);
});

test("the pull request carries a Verified by Friday block with the recording, when there is one", () => {
  let seq = 0;
  const t0 = 1_700_000_000_000;
  const ev = (body: EventBody, kind: "human" | "agent" = "human"): SessionEvent => ({ seq: ++seq, ts: t0 + seq * 1000, actor: kind === "human" ? { id: "Priya", name: "Priya", kind } : { id: "engine:x", name: "Friday Code", kind }, body });
  const events = [
    ev({ type: "session.created", title: "Dark mode", ownerId: "Priya", ownerName: "Priya", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody),
    ev({ type: "instruction", text: "Add the toggle.", interrupt: false }),
    ev({ type: "run.started", causedBy: 2 }, "agent"),
    ev({ type: "agent.message", text: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) }] }, "agent"),
    ev({ type: "tool.result", callId: "c1", name: "run_command", output: "$ npm test\n(exited 0)\n12 passing", isError: false } as EventBody, "agent"),
    ev({ type: "agent.diff", files: [file("src/a.ts", 3, 1)] } as EventBody, "agent"),
    ev({ type: "agent.message", text: "Done; the tests pass.", toolCalls: [] }, "agent"),
    ev({ type: "run.ended", outcome: "done" }, "agent"),
  ];
  const state = project("s", events);
  const body = prBodyFor(state, events, "https://friday.test/?session=s", "https://friday.test/?replay=s&t=tok");
  assert.match(body, /## Verified by Friday\n\*\*Tests passed\*\* \(`npm test`\) · 1 command ran · 1 file changed\n▶ \[Watch the run\]\(https:\/\/friday\.test\/\?replay=s&t=tok\) — a read-only recording/);
  assert.match(body, /Opened from a Friday session: https:\/\/friday\.test\/\?session=s$/);
  assert.ok(!/Watch the run/.test(prBodyFor(state, events, "https://friday.test/?session=s")), "no recording link when the viewer link is off");
});
