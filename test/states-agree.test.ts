// Every place that says a session's state says the same (spec 13 polish; Arun, 2026-11-24: "Go all out and fix these problems"): a
// working agent's words come from one source (step-words.ts liveWords), whether read off the projection for a sidebar row (attention.ts
// crewOf) or off the log for the side panel and the board (activity-line.ts doingNow); and a finished run's summary follows the latest
// check of it (check-state.ts), as the reply's badge does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { doingNow } from "../src/activity-line.js";
import { crewOf } from "../src/attention.js";
import { reviewFacts } from "../src/board.js";
import { checkStateOf, checkWords } from "../src/check-state.js";
import { proofLine } from "../src/client/ThreadCard.js";
import { project } from "../src/session/projection.js";
import { LIVE_WORDS, liveWords, livePhase, workingStep } from "../src/step-words.js";
import { runProof } from "../src/team-proof.js";
import type { ActorRef, EventBody, SessionEvent } from "../src/types.js";

const human: ActorRef = { id: "u1", name: "Arun", kind: "human" };
const agent: ActorRef = { id: "engine:h1", name: "Mac's Claude Code", kind: "agent" };
const friday: ActorRef = { id: "friday", name: "Friday", kind: "system" };
const T = 1_800_000_000_000;
let seq = 0;
const ev = (actor: ActorRef, body: EventBody | Record<string, unknown>): SessionEvent => ({ seq: ++seq, ts: T + seq * 1000, actor, body: body as EventBody });
const created = () => ev(human, { type: "session.created", title: "t", ownerId: "u1", ownerName: "Arun" });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });

/** What the sidebar's row says of the one agent, and what the side panel and board say, off the same log. */
const both = (events: SessionEvent[], streaming: "text" | "reasoning" | null = null) => {
  const crew = crewOf(project("s", events), undefined, "u1", () => streaming)!.agents[0]!;
  return { row: liveWords(crew), panel: doingNow(events, "main", streaming)?.text };
};

test("a working agent is said the same off the projection and off the log: starting, its step, thinking, writing", () => {
  seq = 0;
  const log = [created(), ev(human, { type: "run.started", causedBy: 0 })];
  assert.deepEqual(both(log), { row: LIVE_WORDS.starting, panel: LIVE_WORDS.starting });
  // Its words streaming before it has logged anything: writing; its thinking streaming: thinking.
  assert.deepEqual(both(log, "text"), { row: LIVE_WORDS.writing, panel: LIVE_WORDS.writing });
  assert.deepEqual(both(log, "reasoning"), { row: LIVE_WORDS.thinking, panel: LIVE_WORDS.thinking });
  log.push(ev(agent, { type: "agent.message", text: "", toolCalls: [call("c1", "shell", { command: "npm run build" })] }));
  assert.deepEqual(both(log), { row: "Running npm run build", panel: "Running npm run build" });
  log.push(ev(agent, { type: "tool.result", callId: "c1", name: "shell", output: "built", isError: false }));
  assert.deepEqual(both(log), { row: LIVE_WORDS.thinking, panel: LIVE_WORDS.thinking }, "its step back: deciding what next, not still running it");
  assert.deepEqual(both(log, "text"), { row: LIVE_WORDS.writing, panel: LIVE_WORDS.writing });
  // A step whose result never comes (a plan, say) doesn't read over its streaming answer.
  log.push(ev(agent, { type: "agent.message", text: "", toolCalls: [call("c2", "update_plan", { plan: [] })] }));
  assert.deepEqual(both(log), { row: "Planning", panel: "Planning" });
  assert.deepEqual(both(log, "text"), { row: LIVE_WORDS.writing, panel: LIVE_WORDS.writing });
  // The run ends: no words of work.
  log.push(ev(agent, { type: "run.ended", outcome: "done" }));
  assert.equal(crewOf(project("s", log))!.agents[0]!.phase, undefined);
  assert.equal(doingNow(log, "main"), null);
  // A new run starts afresh.
  log.push(ev(human, { type: "run.started", causedBy: 0 }));
  assert.deepEqual(both(log), { row: LIVE_WORDS.starting, panel: LIVE_WORDS.starting });
});

test("the thread list's and card's step is the same words, and the phases read as the reply's live line does", () => {
  assert.equal(workingStep([{ state: "working", phase: "writing" }]), "Writing its answer");
  assert.equal(workingStep([{ state: "working", phase: "thinking" }, { state: "working", doing: { name: "edit", target: "a/b.ts" } }]), "Editing b.ts", "a step under way first");
  assert.equal(livePhase(false, null), "starting");
  assert.equal(livePhase(true, null), "thinking");
  assert.equal(livePhase(false, "text"), "writing");
});

/** A run that changed a file and ran no test, then whatever came after it. */
function changedRun(...after: Record<string, unknown>[]) {
  seq = 0;
  const events = [
    created(),
    ev(human, { type: "run.started", causedBy: 0 }),
    ev(agent, { type: "agent.message", text: "", toolCalls: [call("e1", "edit", { path: "README.md" })] }),
    ev(agent, { type: "tool.result", callId: "e1", name: "edit", output: "ok", isError: false }),
    ev(agent, { type: "agent.diff", files: [{ path: "README.md", status: "modified", additions: 4, deletions: 0, patch: "@@\n+notes" }] }),
    ev(agent, { type: "agent.message", text: "Done: I added a Notes section.", toolCalls: [] }),
    ev(agent, { type: "run.ended", outcome: "done" }),
  ];
  const end = events.at(-1)!.seq;
  for (const b of after) events.push(ev(friday, b));
  return { events, end, proof: runProof(events, { lane: "main", startSeq: 2, endSeq: end }, "t", "Claude Code") };
}
const passed = { type: "proof.tests", run: 7, by: "friday", runs: [{ command: "npm test", ok: true, passed: 3, failed: 0, tail: "ℹ pass 3" }] };
const failed = { type: "proof.tests", run: 7, by: "friday", runs: [{ command: "npm test", ok: false, passed: 2, failed: 1, failing: ["the cart total rounds to cents"], tail: "✖ the cart total rounds to cents" }] };

test("a finished run's summary follows its latest check, in the reply's badge's words, never 'no tests run' over it", () => {
  const plain = changedRun();
  assert.deepEqual(proofLine(plain.proof, checkStateOf(plain.events, "main", plain.end)), { text: "unverified · 1 file", tone: "warn" });
  const checking = changedRun({ type: "proof.status", stage: "testing", tests: true, asked: true, command: "npm test" });
  assert.deepEqual(proofLine(checking.proof, checkStateOf(checking.events, "main", checking.end)), { text: "Checking… · 1 file", checked: true, tone: "wait" });
  const ok = changedRun({ type: "proof.status", stage: "testing", tests: true, asked: true, command: "npm test" }, passed);
  const st = checkStateOf(ok.events, "main", ok.end);
  assert.equal(checkWords(st)!.text, "Checked · 3 tests pass");
  assert.deepEqual(proofLine(ok.proof, st), { text: "Checked · 3 tests pass · 1 file", checked: true });
  // The proof itself has Friday's check among its checks, so its details agree too.
  assert.deepEqual(ok.proof.checks.map((c) => [c.command, c.ok, c.by]), [["npm test", true, "friday"]]);
  const bad = changedRun(failed);
  assert.deepEqual(proofLine(bad.proof, checkStateOf(bad.events, "main", bad.end)), { text: "Check failed · 1 file", checked: true, tone: "bad" });
  // A run that changed nothing and ran nothing: its own words say it, not "no tests run".
  seq = 0;
  const said = [created(), ev(human, { type: "run.started", causedBy: 0 }), ev(agent, { type: "agent.message", text: "Here is how it works.", toolCalls: [] }), ev(agent, { type: "run.ended", outcome: "done" })];
  assert.equal(proofLine(runProof(said, { lane: "main", startSeq: 2, endSeq: 4 }, "t", "Claude Code")), null);
});

test("the board's card reads its tests from the latest check of the run, not 'Tests not run' over it", () => {
  const plain = changedRun();
  assert.equal(reviewFacts(plain.events, true)?.tests, "none");
  assert.equal(reviewFacts(changedRun(passed).events, true)?.tests, "pass");
  assert.equal(reviewFacts(changedRun(failed).events, true)?.tests, "fail");
});
