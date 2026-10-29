// Crew: side threads in the Team room.
import assert from "node:assert/strict";
import test from "node:test";
import { threadsOf } from "../src/client/team-threads.js";
import { promptFor } from "../src/engine/hub.js";
import type { SessionEvent } from "../src/types.js";

let seq = 0;
const ev = (lane: string, actor: { id: string; name: string; kind: string }, body: Record<string, unknown>) => ({ seq: ++seq, ts: seq * 1000, lane, actor, body }) as unknown as SessionEvent;
const me = { id: "u", name: "Arun", kind: "human" };
const kit = { id: "agent", name: "Kit", kind: "agent" };

test("a side thread: the reply and the teammate's answer to it sit under the message they are about, out of the room's main flow", () => {
  const asked = ev("k", me, { type: "instruction", text: "Build the pricing page", interrupt: false });
  const r1 = ev("k", kit, { type: "run.started", causedBy: asked.seq });
  const done = ev("k", kit, { type: "agent.message", text: "Built it: three plans, monthly and yearly.", toolCalls: [] });
  const e1 = ev("k", kit, { type: "run.ended", outcome: "done" });
  const reply = ev("k", me, { type: "instruction", text: "Why yearly first?", interrupt: false, thread: { root: done.seq } });
  const r2 = ev("k", kit, { type: "run.started", causedBy: reply.seq });
  const step = ev("k", kit, { type: "agent.message", text: "", toolCalls: [{ id: "x", name: "Read", arguments: "{}" }] });
  const answer = ev("k", kit, { type: "agent.message", text: "Yearly converts better on the old page.", toolCalls: [] });
  const e2 = ev("k", kit, { type: "run.ended", outcome: "done" });
  const after = ev("k", me, { type: "instruction", text: "Now the FAQ", interrupt: false });
  const r3 = ev("k", kit, { type: "run.started", causedBy: after.seq });
  const faq = ev("k", kit, { type: "agent.message", text: "FAQ done.", toolCalls: [] });
  const events = [asked, r1, done, e1, reply, r2, step, answer, e2, after, r3, faq];
  const t = threadsOf(events);
  assert.deepEqual(t.byRoot.get(done.seq)?.map((e) => e.seq), [reply.seq, answer.seq], "the reply, then the answer");
  for (const s of [reply.seq, step.seq, answer.seq]) assert.ok(t.hidden.has(s), "kept out of the main flow");
  for (const s of [asked.seq, done.seq, after.seq, faq.seq]) assert.ok(!t.hidden.has(s), "the room's own work stays in it");
  assert.equal(threadsOf(events), t, "worked out once per log");

  const { prompt } = promptFor(events, [reply.seq]);
  assert.match(prompt, /^Arun, in a side thread on your message "Built it: three plans, monthly and yearly\.": Why yearly first\?/);
  assert.match(prompt, /stays in the thread/);
});

test("the room keeps results and the person's words; the agents' talk folds to a line, Friday's notes leave it (OpenBot's channels)", async () => {
  const { foldTeamTalk, teamEventKind } = await import("../src/client/Teammates.js");
  const nova = { id: "agent", name: "Nova", kind: "agent" };
  const fri = { id: "friday", name: "Friday", kind: "agent" };
  const say = ev("n", me, { type: "instruction", text: "Plan launch week", interrupt: false });
  const task = ev("k", nova, { type: "instruction", text: "Do the landing page", interrupt: false, mesh: { id: "m1", kind: "task", fromLane: "n", fromName: "Nova", toName: "Kit", hop: 1, by: null } });
  const post = ev("n", nova, { type: "mesh.posted", id: "p1", fromLane: "n", fromName: "Nova", text: "Split the work" });
  const note = ev("n", fri, { type: "instruction", text: "[Friday] The board task is done (Kit).", interrupt: false });
  const held = ev("k", kit, { type: "files.held", paths: ["a.ts"] });
  const answer = ev("n", nova, { type: "agent.message", text: "Done: the plan is in plan.md.", toolCalls: [] });
  assert.equal(teamEventKind(say, true), "show");
  assert.equal(teamEventKind(task, true), "talk");
  assert.equal(teamEventKind(post, true), "talk");
  assert.equal(teamEventKind(note, true), "hide", "Friday's note to an agent stays out of the room");
  assert.equal(teamEventKind(held, true), "hide", "and so does coordination");
  assert.equal(teamEventKind(note, false), "talk", "in a teammate's own chat it folds with the talk instead");
  const items = [say, task, post, note, held, answer];
  const f = foldTeamTalk(items, (e) => (e === answer ? "show" : teamEventKind(e, true)), (e) => e.seq);
  assert.deepEqual(f.items.map((e) => e.seq), [say.seq, task.seq, answer.seq], "one line for the stretch, then the answer");
  assert.deepEqual(f.groups.get(task.seq)?.map((e) => e.seq), [task.seq, post.seq]);
});

test("a thread's words are what its teammate says once handed only that thread's replies: mid-turn, or queued with a room message", () => {
  const a1 = ev("k", me, { type: "instruction", text: "Build pricing", interrupt: false });
  const r1 = ev("k", kit, { type: "run.started", causedBy: a1.seq });
  const root = ev("k", kit, { type: "agent.message", text: "Built pricing.", toolCalls: [] });
  const e1 = ev("k", kit, { type: "run.ended", outcome: "done" });
  // Replied to while it is busy on the next thing: handed mid-turn, its answer is the thread's.
  const a2 = ev("k", me, { type: "instruction", text: "Now FAQ", interrupt: false });
  const r2 = ev("k", kit, { type: "run.started", causedBy: a2.seq });
  const d2 = ev("k", kit, { type: "instructions.delivered", seqs: [a2.seq] });
  const faq = ev("k", kit, { type: "agent.message", text: "FAQ drafted.", toolCalls: [] });
  const reply = ev("k", me, { type: "instruction", text: "Why yearly?", interrupt: false, thread: { root: root.seq } });
  const d3 = ev("k", kit, { type: "instructions.delivered", seqs: [reply.seq] });
  const ans = ev("k", kit, { type: "agent.message", text: "Yearly converts better.", toolCalls: [] });
  // Handed a room message next: what it says after that is the room's again.
  const a3 = ev("k", me, { type: "instruction", text: "And ship it", interrupt: false });
  const d4 = ev("k", kit, { type: "instructions.delivered", seqs: [a3.seq] });
  const shipped = ev("k", kit, { type: "agent.message", text: "Shipped.", toolCalls: [] });
  const e2 = ev("k", kit, { type: "run.ended", outcome: "done" });
  let t = threadsOf([a1, r1, root, e1, a2, r2, d2, faq, reply, d3, ans, a3, d4, shipped, e2]);
  assert.deepEqual(t.byRoot.get(root.seq)?.map((e) => e.seq), [reply.seq, ans.seq]);
  assert.ok(t.hidden.has(ans.seq), "the answer handed mid-turn is the thread's");
  for (const s of [faq.seq, shipped.seq]) assert.ok(!t.hidden.has(s), "the turn's own work stays in the room");
  assert.equal(t.state.get(root.seq), "answered");

  // A reply queued together with a room message: one turn, handed both, its words are the room's.
  const b1 = ev("k", me, { type: "instruction", text: "Why monthly?", interrupt: false, thread: { root: root.seq } });
  const b2 = ev("k", me, { type: "instruction", text: "@Kit also ship the FAQ to prod", interrupt: false });
  const r3 = ev("k", kit, { type: "run.started", causedBy: b1.seq });
  const d5 = ev("k", kit, { type: "instructions.delivered", seqs: [b1.seq, b2.seq] });
  const both = ev("k", kit, { type: "agent.message", text: "Monthly is cheaper. FAQ shipped to prod.", toolCalls: [] });
  const e3 = ev("k", kit, { type: "run.ended", outcome: "done" });
  t = threadsOf([a1, r1, root, e1, b1, b2, r3, d5, both, e3]);
  assert.ok(!t.hidden.has(both.seq), "the room message's answer stays in the room");
  assert.ok(t.hidden.has(b1.seq), "the reply itself is the thread's");
});

test("how a thread stands: answering until its turn ends, then answered, failed, or stopped; a failed turn's end isn't a room row", () => {
  const asked = ev("k", me, { type: "instruction", text: "Build pricing", interrupt: false });
  const r1 = ev("k", kit, { type: "run.started", causedBy: asked.seq });
  const root = ev("k", kit, { type: "agent.message", text: "Built pricing.", toolCalls: [] });
  const e1 = ev("k", kit, { type: "run.ended", outcome: "done" });
  const c1 = ev("k", me, { type: "instruction", text: "Why?", interrupt: false, thread: { root: root.seq } });
  let t = threadsOf([asked, r1, root, e1, c1]);
  assert.equal(t.state.get(root.seq), "answering");
  const r2 = ev("k", kit, { type: "run.started", causedBy: c1.seq });
  const e2 = ev("k", kit, { type: "run.ended", outcome: "error", error: "boom" });
  t = threadsOf([asked, r1, root, e1, c1, r2, e2]);
  assert.equal(t.state.get(root.seq), "failed", "not \"is answering…\" for good");
  assert.ok(t.hidden.has(e2.seq), "its error is the thread's, not a row in the room");
  const c2 = ev("k", me, { type: "instruction", text: "Try again?", interrupt: false, thread: { root: root.seq } });
  const r3 = ev("k", kit, { type: "run.started", causedBy: c2.seq });
  const stop = ev("k", me, { type: "run.cancel" });
  t = threadsOf([asked, r1, root, e1, c1, r2, e2, c2, r3, stop]);
  assert.equal(t.state.get(root.seq), "stopped");
  const c3 = ev("k", me, { type: "instruction", text: "Once more", interrupt: false, thread: { root: root.seq } });
  const r4 = ev("k", kit, { type: "run.started", causedBy: c3.seq });
  const ans = ev("k", kit, { type: "agent.message", text: "Because the old page converted better.", toolCalls: [] });
  const e4 = ev("k", kit, { type: "run.ended", outcome: "done" });
  t = threadsOf([asked, r1, root, e1, c1, r2, e2, c2, r3, stop, c3, r4, ans, e4]);
  assert.equal(t.state.get(root.seq), "answered");
});

// Logic audit round two (Arun, 2026-10-28: "run an audit on the teams stuff…").
test("a thread whose turn the person Stops (run.pause) is stopped, not 'answering' for ever; a reply still queued keeps it answering", () => {
  const asked = ev("k", me, { type: "instruction", text: "Build it", interrupt: false });
  const r1 = ev("k", kit, { type: "run.started", causedBy: asked.seq });
  const done = ev("k", kit, { type: "agent.message", text: "Built.", toolCalls: [] });
  const e1 = ev("k", kit, { type: "run.ended", outcome: "done" });
  const reply = ev("k", me, { type: "instruction", text: "Why?", interrupt: false, thread: { root: done.seq } });
  const r2 = ev("k", kit, { type: "run.started", causedBy: reply.seq });
  const pause = ev("k", me, { type: "run.pause" });
  const next = ev("k", me, { type: "instruction", text: "Do the FAQ", interrupt: false });
  const r3 = ev("k", kit, { type: "run.started", causedBy: next.seq });
  const faq = ev("k", kit, { type: "agent.message", text: "FAQ done.", toolCalls: [] });
  const e3 = ev("k", kit, { type: "run.ended", outcome: "done" });
  const t = threadsOf([asked, r1, done, e1, reply, r2, pause, next, r3, faq, e3]);
  assert.equal(t.state.get(done.seq), "stopped");
  assert.ok(t.hidden.has(pause.seq), "the thread's turn's end is the thread's");
  assert.ok(!t.hidden.has(faq.seq), "the next turn's words are the room's");
  // Queued, not yet handed: a Stop keeps it, so it is still coming.
  const done2 = ev("k", kit, { type: "agent.message", text: "Shipped.", toolCalls: [] });
  const queued = ev("k", me, { type: "instruction", text: "And the tests?", interrupt: false, thread: { root: done2.seq } });
  const pause2 = ev("k", me, { type: "run.pause" });
  assert.equal(threadsOf([done2, queued, pause2]).state.get(done2.seq), "answering");
});

test("a thread's teammate taken out of the room is stopped; a reply withdrawn before it was picked up settles its thread", () => {
  const done = ev("k", kit, { type: "agent.message", text: "Built.", toolCalls: [] });
  const reply = ev("k", me, { type: "instruction", text: "Why?", interrupt: false, thread: { root: done.seq } });
  assert.equal(threadsOf([done, reply, ev("", me, { type: "lane.removed", laneId: "k" })]).state.get(done.seq), "stopped");
  const done2 = ev("k", kit, { type: "agent.message", text: "Built.", toolCalls: [] });
  const reply2 = ev("k", me, { type: "instruction", text: "Why?", interrupt: false, thread: { root: done2.seq } });
  assert.notEqual(threadsOf([done2, reply2, ev("k", me, { type: "instruction.withdrawn", seq: reply2.seq })]).state.get(done2.seq), "answering");
});
