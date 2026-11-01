import assert from "node:assert/strict";
import test from "node:test";
import { AgentMesh } from "../src/agent-mesh.js";
import { project } from "../src/session/projection.js";
import { teamBrief } from "../src/team-away.js";
import { missingLine, proofsIn, proofSummary, runProof, taskProof } from "../src/team-proof.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/**
 * Proof of work (Arun, 2026-10-31): every task a teammate hands in carries its checks, what it changed, a picture of the page it
 * touched where there is one, and its own short review; a task handed in without it says so, and its reviewer reads it first.
 */

const ADA: ActorRef = { id: "u-ada", name: "Ada", kind: "human" };
const bot = (name: string): ActorRef => ({ id: "agent", name, kind: "agent" });

function memory() {
  const events: SessionEvent[] = [];
  const store = {
    async state() {
      return project("s", events);
    },
    async events() {
      return events;
    },
    async exists() {
      return events.length > 0;
    },
    async append(_sid: string, actor: ActorRef, body: EventBody, opts: { lane?: string } = {}) {
      const seq = events.length + 1;
      events.push({ seq, ts: 1_000_000 + seq * 1000, actor, body, ...(opts.lane && opts.lane !== MAIN_LANE ? { lane: opts.lane } : {}) } as SessionEvent);
      return { ok: true as const, seq };
    },
  };
  const mesh = new AgentMesh(store as never, { wake: async () => {} } as never);
  const add = (body: EventBody, lane?: string, actor: ActorRef = ADA) => store.append("s", actor, body, lane ? { lane } : {});
  return { events, store, mesh, add };
}

async function team() {
  const m = memory();
  await m.add({ type: "session.created", title: "t", ownerId: ADA.id, ownerName: ADA.name });
  for (const [id, name] of [["lb", "Builder"], ["lw", "Writer"]] as const) await m.add({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } } as EventBody);
  return m;
}

const file = (path: string, additions: number, deletions = 0) => ({ path, status: "modified" as const, additions, deletions, patch: "" });
/** A command the teammate ran and how it went, as a coding tool's turn logs it. */
async function ran(m: Awaited<ReturnType<typeof team>>, lane: string, command: string, ok: boolean) {
  const id = `c${m.events.length}`;
  await m.add({ type: "agent.message", text: "", toolCalls: [{ id, name: "shell", arguments: JSON.stringify({ command }) }] }, lane, bot("x"));
  await m.add({ type: "tool.result", callId: id, name: "shell", output: ok ? "ok" : "1 failed", isError: !ok }, lane, bot("x"));
}

test("a backend task handed in with proof: its checks, only the files it changed, its review, no picture, and the reviewer reads it first", async () => {
  const m = await team();
  // Builder had already changed a file before it took the task: not this task's work.
  await m.add({ type: "agent.diff", base: "b", files: [file("src/old.ts", 3)] }, "lb", bot("Builder"));
  await m.mesh.postTasks("s", MAIN_LANE, [{ id: "api", title: "Add the refunds endpoint", detail: "POST /refunds", agent: "builder" }]);
  const t = (await m.store.state()).board!.tasks.find((x) => x.id === "api")!;
  assert.equal(t.lane, "lb");
  await m.add({ type: "agent.diff", base: "b", files: [file("src/old.ts", 3), file("src/refunds.ts", 40, 2)] }, "lb", bot("Builder"));
  await ran(m, "lb", "npm test -- refunds", true);
  const posted = await m.mesh.call("s", "lb", "post_proof", { done: "Added POST /refunds.", checked: "npm test -- refunds passed, 4 tests.", unsure: "Partial refunds aren't covered." });
  assert.match(posted.output, /Proof kept for "api"/);
  assert.equal(posted.capture, undefined, "no page, no picture asked for");
  const done = await m.mesh.call("s", "lb", "finish_task", { id: "api", report: "Done." });
  assert.doesNotMatch(done.output, /without proof/);

  const p = taskProof(m.events, "api", "s")!;
  assert.equal(p.title, "Add the refunds endpoint");
  assert.deepEqual(p.review, { done: "Added POST /refunds.", checked: "npm test -- refunds passed, 4 tests.", unsure: "Partial refunds aren't covered." });
  assert.deepEqual(p.changed.files.map((f) => f.path), ["src/refunds.ts"], "the file it had changed before is left out");
  assert.deepEqual([p.changed.add, p.changed.del], [40, 2]);
  assert.deepEqual(p.checks.map((c) => [c.command, c.ok, c.by]), [["npm test -- refunds", true, "self"]]);
  assert.equal(p.page, undefined);
  assert.deepEqual(p.missing, []);
  assert.equal(missingLine(p), "");
  assert.equal(proofSummary(p), "Checks pass · 1 file +40 −2 · self-reviewed");

  // Writer is asked to review it, and reads the proof before the task and the report.
  const ask = m.events.findLast((e) => e.lane === "lw" && e.body.type === "instruction" && e.body.mesh?.review);
  assert.ok(ask?.body.type === "instruction");
  const text = ask.body.text;
  assert.ok(text.indexOf("Proof, from Builder") > 0 && text.indexOf("Proof, from Builder") < text.indexOf("The task:"), text);
  assert.match(text, /Still uncertain: Partial refunds aren't covered\./);
  assert.match(text, /Changed: src\/refunds\.ts \+40 −2/);
});

test("a UI change: the page is pictured where the runner can, kept with the proof; anywhere else the proof keeps its address", async () => {
  const m = await team();
  const saved: { sid: string; bytes: number; type: string }[] = [];
  m.mesh.proofFiles = async (sid, data, type) => (saved.push({ sid, bytes: data.length, type }), "f1");
  await m.mesh.postTasks("s", MAIN_LANE, [{ id: "ui", title: "Restyle the settings page", detail: "x", agent: "builder" }]);
  // Only a page on this machine.
  const away = await m.mesh.call("s", "lb", "post_proof", { done: "a", checked: "b", unsure: "c", page: "https://example.com" });
  assert.equal(away.isError, true);
  assert.equal(m.events.filter((e) => e.body.type === "proof.posted").length, 0);
  // No proof asks for a picture yet: one sent anyway isn't kept.
  assert.equal((await m.mesh.call("s", "lb", "__proof_shot", { data: Buffer.from("png").toString("base64"), mimeType: "image/png" })).isError, true);

  const r = await m.mesh.call("s", "lb", "post_proof", { done: "Restyled it.", checked: "Looked at it at 1280.", unsure: "Nothing", page: "5173" });
  assert.deepEqual(r.capture, { url: "http://localhost:5173/", width: 1280, height: 800, fullPage: false });
  // A runner that can't take pictures sends nothing: the proof has the address alone.
  assert.deepEqual(taskProof(m.events, "ui")?.page, undefined, "not handed in yet");
  await m.mesh.call("s", "lb", "finish_task", { id: "ui", report: "Done." });
  assert.deepEqual(taskProof(m.events, "ui", "s")!.page, { url: "http://localhost:5173/" });
  // The desktop app's runner sends the picture back.
  assert.equal((await m.mesh.call("s", "lb", "__proof_shot", { data: Buffer.from("not really a png").toString("base64"), mimeType: "text/html" })).isError, true, "pictures only");
  const kept = await m.mesh.call("s", "lb", "__proof_shot", { data: Buffer.from("png bytes").toString("base64"), mimeType: "image/png", width: 1280, height: 800 });
  assert.match(kept.output, /Kept with the proof/);
  assert.deepEqual(saved, [{ sid: "s", bytes: 9, type: "image/png" }]);
  assert.deepEqual(taskProof(m.events, "ui", "s")!.page, { url: "http://localhost:5173/", file: "f1", sid: "s", width: 1280, height: 800 });
  assert.equal((await m.mesh.call("s", "lb", "__proof_shot", { data: Buffer.from("again").toString("base64"), mimeType: "image/png" })).isError, true, "one picture a proof");
  assert.match(proofSummary(taskProof(m.events, "ui", "s")!), /picture · self-reviewed$/);
});

test("handed in without proof: it is told to post it, and the proof says what it lacks; checks that failed or couldn't run say so", async () => {
  const m = await team();
  await m.mesh.postTasks("s", MAIN_LANE, [{ id: "a", title: "Fix the copy", detail: "x", agent: "builder" }]);
  const done = await m.mesh.call("s", "lb", "finish_task", { id: "a", report: "Fixed it." });
  assert.match(done.output, /went in without proof: post_proof for "a" now/);
  let p = taskProof(m.events, "a")!;
  assert.deepEqual(p.missing, ["a self-review", "checks"]);
  assert.equal(missingLine(p), "Handed in without a self-review or checks.");
  assert.equal(proofSummary(p), "No checks run · No files changed · no self-review");
  // Friday's check couldn't run there (a Manual machine): no checks still.
  await m.add({ type: "board.checked", id: "a", lane: "lb", command: "npm run typecheck", ok: true, output: "Manual mode", skipped: true }, "lb");
  p = taskProof(m.events, "a")!;
  assert.deepEqual(p.checks, [{ command: "npm run typecheck", ok: true, by: "friday", skipped: true }]);
  assert.deepEqual(p.missing, ["a self-review", "checks"]);
  // Posted late, still before anyone took it again: it counts. Friday's failed check leads, with what it printed.
  await m.mesh.call("s", "lb", "post_proof", { id: "a", done: "Fixed the copy.", checked: "Read it.", unsure: "Nothing" });
  await m.add({ type: "board.checked", id: "a", lane: "lb", command: "npm run typecheck", ok: false, output: "src/a.ts(3,1): error TS2304" }, "lb");
  p = taskProof(m.events, "a")!;
  assert.deepEqual(p.missing, []);
  assert.deepEqual(p.checks, [{ command: "npm run typecheck", ok: false, by: "friday", output: "src/a.ts(3,1): error TS2304" }]);
  assert.match(proofSummary(p), /^Checks failed/);
});

test("a task id used again on a new board is a task of its own; a lead's goal run carries proof too", async () => {
  const m = await team();
  await m.mesh.postTasks("s", MAIN_LANE, [{ id: "t1", title: "First board's task", detail: "x", agent: "builder" }]);
  await m.mesh.call("s", "lb", "post_proof", { done: "First.", checked: "x", unsure: "y" });
  await m.mesh.call("s", "lb", "finish_task", { id: "t1", report: "Done." });
  await m.add({ type: "board.reviewed", id: "t1", lane: "lw", name: "Writer", ok: true, note: "ok" }, "lw");
  await m.mesh.postTasks("s", MAIN_LANE, [{ id: "t1", title: "Second board's task", detail: "x" }]);
  const holder = (await m.store.state()).board!.tasks[0]!.lane!;
  assert.match((await m.mesh.call("s", holder, "finish_task", { id: "t1", report: "Done." })).output, /without proof/);
  const p = taskProof(m.events, "t1")!;
  assert.equal(p.title, "Second board's task");
  assert.equal(p.review, undefined, "the first board's proof isn't this one's");
  // The lead's own run toward the person's goal, with its proof posted without a task.
  const goal = await m.add({ type: "instruction", text: "Ship the refunds flow", interrupt: false });
  const start = await m.add({ type: "run.started", causedBy: goal.seq }, MAIN_LANE, bot("Lead"));
  await m.add({ type: "agent.diff", base: "b", files: [file("src/flow.ts", 12)] }, MAIN_LANE, bot("Lead"));
  await m.mesh.call("s", MAIN_LANE, "post_proof", { done: "Merged both branches.", checked: "npm test passed.", unsure: "Nothing" });
  const end = await m.add({ type: "run.ended", outcome: "done" }, MAIN_LANE, bot("Lead"));
  const run = runProof(m.events, { lane: MAIN_LANE, startSeq: start.seq, endSeq: end.seq }, "Ship the refunds flow", "Lead");
  assert.equal(run.task, undefined);
  assert.equal(run.review?.done, "Merged both branches.");
  assert.deepEqual(run.changed.files.map((f) => f.path), ["src/flow.ts"]);
  // The shelf: both boards' tasks and the run, newest first.
  const shelf = proofsIn(m.events, "s", (l) => (l === MAIN_LANE ? "Lead" : undefined));
  assert.deepEqual(shelf.map((x) => x.title), ["Ship the refunds flow", "Second board's task", "First board's task"]);
});

test("the brief carries each done task's proof, and a plain answer in the room none", () => {
  const ev: SessionEvent[] = [];
  const add = (body: EventBody, lane?: string) => ev.push({ seq: ev.length + 1, ts: 5000 + ev.length, actor: bot("x"), body, ...(lane ? { lane } : {}) } as SessionEvent);
  add({ type: "board.posted", fromLane: "l1", fromName: "Maya", tasks: [{ id: "t1", title: "Add refunds", detail: "", owns: [], after: [] }] });
  add({ type: "board.claimed", id: "t1", lane: "l2", name: "Kit" }, "l2");
  add({ type: "run.started", causedBy: 0 }, "l2");
  add({ type: "agent.diff", base: "b", files: [file("src/refunds.ts", 10)] }, "l2");
  add({ type: "proof.posted", id: "t1", done: "Added refunds.", checked: "npm test passed.", unsure: "Nothing", page: "http://localhost:5173/" }, "l2");
  add({ type: "proof.shot", proof: 5, url: "http://localhost:5173/", file: "f9" }, "l2");
  add({ type: "board.finished", id: "t1", lane: "l2", name: "Kit", status: "done", report: "Done" }, "l2");
  add({ type: "run.ended", outcome: "done" }, "l2");
  // Maya answers a question in the room: a result, not work to prove.
  add({ type: "instruction", text: "What's left?", interrupt: false }, "l1");
  add({ type: "run.started", causedBy: 9 }, "l1");
  add({ type: "agent.message", text: "Only the docs.", toolCalls: [] }, "l1");
  add({ type: "run.ended", outcome: "done" }, "l1");
  const b = teamBrief([{ sid: "room1", room: "Refunds", events: ev, lanes: { kit: "l2", maya: "l1" } }], [{ id: "kit", name: "Kit", lane: "k" }, { id: "maya", name: "Maya", lane: "m" }], 0, 99_999);
  const kit = b.done.find((d) => d.name === "Kit")!;
  assert.equal(kit.proof?.review?.done, "Added refunds.");
  assert.deepEqual(kit.proof?.page, { url: "http://localhost:5173/", file: "f9", sid: "room1" });
  assert.deepEqual(kit.proof?.changed.files.map((f) => f.path), ["src/refunds.ts"]);
  const maya = b.done.find((d) => d.name === "Maya")!;
  assert.equal(maya.proof, undefined);
});
