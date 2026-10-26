import assert from "node:assert/strict";
import test from "node:test";
import { awayDiff, declines, pickReviewer, reviewPasses, saysBlocked, unheardEnd } from "../src/agent-mesh.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

// Each from Edge Defense's session on 2026-10-24 (b25-oBsr, ~19,500 events): the board's tasks that went "Stuck", "Not
// finished" or "Checked" when they weren't (Arun: "look into why things get stuck and please make this more reliable").

test("a review that won't pass it fails, even when it quotes someone else's all clear", () => {
  const t3 =
    "I couldn't review this one, so I'm giving no approval.\n\n- **No diff to check:** the work is in a folder I can't open.\n\n**Changes needed:** Codex's own report lists two runner blockers.\n\nI can't check whether the two blockers are fixed. Codex says it found no blockers there.";
  assert.equal(reviewPasses(t3), false);
  assert.equal(reviewPasses("Not approved: the migration drops a column."), false);
  assert.equal(reviewPasses("No changes needed. The fix reads well and its test covers it."), true, "no changes needed is a pass");
  assert.equal(reviewPasses("Approved. No changes needed; one note for later."), true);
});

test("held up is the agent saying so of itself, not the word anywhere in its report", () => {
  assert.equal(saysBlocked("I've corrected my t1 findings. I also tried to message Codex and Chat directly, but Friday blocked both."), false);
  assert.equal(saysBlocked("The firewall blocked the scan, which is why there were zero events."), false);
  assert.equal(saysBlocked("I'm blocked on the API key: it isn't in the vault."), true);
  assert.equal(saysBlocked("Blocked: needs a decision on the schema."), true);
  assert.equal(saysBlocked("I can't proceed without access to the Pi."), true);
  assert.equal(saysBlocked("Still stuck on the flaky test."), true);
});

test("turning a task down is read from the report's opening, whatever it was marked", () => {
  assert.equal(declines("Skipping `t4`, as Boss asked. Chat with me owns it, and it needs the worktrees, which I can't see. I made no edits."), true);
  assert.equal(declines("Not mine: the lead gave this to Codex."), true);
  assert.equal(declines("Leaving it to Codex, which already has the branch."), true);
  assert.equal(declines("Done. The script now retries the DNS phase.\n\nI skipped the flaky soak test, which needs the Pi."), false, "a skip later on, in a finished report, isn't turning it down");
});

const at = (bodies: [EventBody, string | undefined][]): SessionEvent[] =>
  bodies.map(([body, lane], i) => ({ seq: i + 1, ts: 1_000 + i, actor: { id: "x", name: "x", kind: "agent" }, body, ...(lane ? { lane } : {}) }) as SessionEvent);

test("a turn that ended after its task was given, with the board hearing nothing, is one to settle", () => {
  // t2: claimed, its run went and ended, and no board.finished followed (the server was being replaced as it ended).
  const lost = at([
    [{ type: "instruction", text: "Board task t2", interrupt: false, mesh: { id: "m", kind: "task", board: "t2", fromLane: "main", fromName: "Boss", toName: "Chat with me", hop: 1, by: null } } as EventBody, "l2"],
    [{ type: "board.claimed", id: "t2", lane: "l2", name: "Chat with me" } as EventBody, "l2"],
    [{ type: "run.started", causedBy: 1 } as EventBody, "l2"],
    [{ type: "run.ended", outcome: "done" } as EventBody, "l2"],
  ]);
  assert.equal(!!unheardEnd(lost, "t2", "l2"), true);
  // Settled: nothing more to do.
  assert.equal(!!unheardEnd([...lost, { seq: 5, ts: 2000, actor: { id: "f", name: "Friday", kind: "system" }, lane: "l2", body: { type: "board.finished", id: "t2", lane: "l2", name: "Chat with me", status: "done", report: "r" } } as SessionEvent], "t2", "l2"), false);
  // Its turn still to end, cut off by a lost connection (it carries on), or waiting on a person: not yet.
  assert.equal(!!unheardEnd(lost.slice(0, 3), "t2", "l2"), false);
  assert.equal(!!unheardEnd(at([[{ type: "board.claimed", id: "t2", lane: "l2", name: "c" } as EventBody, "l2"], [{ type: "run.ended", outcome: "done", cut: true } as EventBody, "l2"]]), "t2", "l2"), false);
  // A turn that ended before the task was given says nothing about it.
  assert.equal(!!unheardEnd(at([[{ type: "run.ended", outcome: "done" } as EventBody, "l2"], [{ type: "board.claimed", id: "t2", lane: "l2", name: "c" } as EventBody, "l2"]]), "t2", "l2"), false);
  // A reviewer's turn after it was asked to check the task.
  assert.equal(!!unheardEnd(at([[{ type: "board.review", id: "t3", lane: "l4", name: "r" } as EventBody, "l4"], [{ type: "run.ended", outcome: "done" } as EventBody, "l4"]]), "t3", "l4", true), true);
  // t2 as it went: its own turn, then one the lead started with a message about something else. The task's turn is the one.
  const later = at([
    [{ type: "instruction", text: "Board task t2", interrupt: false, mesh: { id: "m", kind: "task", board: "t2", fromLane: "main", fromName: "Boss", toName: "Chat", hop: 1, by: null } } as EventBody, "l2"],
    [{ type: "board.claimed", id: "t2", lane: "l2", name: "Chat" } as EventBody, "l2"],
    [{ type: "run.started", causedBy: 1 } as EventBody, "l2"],
    [{ type: "run.ended", outcome: "done" } as EventBody, "l2"],
    [{ type: "instruction", text: "constraints", interrupt: false, mesh: { id: "n", kind: "tell", fromLane: "main", fromName: "Boss", toName: "Chat", hop: 3, by: null } } as EventBody, "l2"],
    [{ type: "run.started", causedBy: 5 } as EventBody, "l2"],
    [{ type: "run.ended", outcome: "done" } as EventBody, "l2"],
  ]);
  assert.equal(unheardEnd(later, "t2", "l2")?.seq, 4, "the end of the turn the task's brief started");
});

test("a task's review goes to an agent on the same computer first; one elsewhere is given the diff", () => {
  const state = project(
    "s",
    at([
      [{ type: "session.created", title: "s", ownerId: "u", ownerName: "Arun" } as EventBody, undefined],
      [{ type: "engine.attached", engine: { tool: "codex", cwd: "/Users/arun/edge-3854d945", hostId: "arun", hostName: "Arun", mode: "full", branch: "friday/codex" } } as EventBody, "doer"],
      [{ type: "engine.attached", engine: { tool: "claude", cwd: "/Users/arokia/edge", hostId: "arokia", hostName: "Arokia", mode: "full" } } as EventBody, "far"],
      [{ type: "engine.attached", engine: { tool: "claude", cwd: "/Users/arun/edge-d41d587d", hostId: "arun", hostName: "Arun", mode: "full" } } as EventBody, "near"],
      [{ type: "agent.diff", base: "abc", files: [{ path: "scripts/run.sh", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-old\n+new\n+more" }] } as EventBody, "doer"],
    ]),
  );
  assert.equal(pickReviewer(state, "doer", ["far", "near"]), "near", "the one that can open the folder");
  assert.equal(pickReviewer(state, "doer", ["far"]), "far", "else whoever is free");
  assert.equal(awayDiff(state, "doer", "near"), "", "it can read the folder itself");
  const brief = awayDiff(state, "doer", "far");
  assert.match(brief, /scripts\/run\.sh \(modified, \+2 -1\)/);
  assert.match(brief, /\+new/);
});
