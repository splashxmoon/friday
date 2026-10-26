import assert from "node:assert/strict";
import test from "node:test";
import { group } from "../src/client/Activity.js";
import { taskStatus } from "../src/client/AgentTalk.js";
import { project } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/** The session page saying what is so (Arun, 2026-10-24: "make this entire coding session thing stable ... rock solid"). */

const ada: ActorRef = { id: "u-ada", name: "Ada", kind: "human" };
const bot = (name: string): ActorRef => ({ id: `engine:${name}`, name, kind: "agent" });
let seq = 0;
const ev = (body: object, lane?: string, actor: ActorRef = ada) => ({ seq: ++seq, ts: seq * 1000, actor, body, ...(lane ? { lane } : {}) }) as SessionEvent;

test("the same change set reported again (a tool reconnecting) is one card, not one a reconnect", () => {
  seq = 0;
  const files = [{ path: "a.ts", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }];
  const items = group([ev({ type: "session.created", title: "t", ownerId: ada.id, ownerName: ada.name }), ev({ type: "agent.diff", files }, undefined, bot("Codex")), ev({ type: "agent.diff", files }, undefined, bot("Codex")), ev({ type: "agent.diff", files }, undefined, bot("Codex"))], false);
  assert.equal(items.filter((i) => i.kind === "event" && i.ev.body.type === "agent.diff").length, 1);
  // A different change set with nothing of the lane's between is the folder now, in the earlier card's place (each runner
  // measures from where it stands, so two reports of one folder can differ); the newest is what is drawn.
  const more = group([ev({ type: "agent.diff", files }, undefined, bot("Codex")), ev({ type: "agent.diff", files: [...files, { path: "b.ts", additions: 1, deletions: 0, patch: "@@ +1 @@\n+c" }] }, undefined, bot("Codex"))], false);
  const drawn = more.filter((i) => i.kind === "event" && i.ev.body.type === "agent.diff") as Extract<(typeof more)[number], { kind: "event" }>[];
  assert.equal(drawn.length, 1);
  assert.equal((drawn[0]!.ev.body as { files: unknown[] }).files.length, 2);
});

test("a task's card says where the task stands: on it, stopped, moved on, being checked, done", () => {
  seq = 0;
  const base: SessionEvent[] = [
    ev({ type: "session.created", title: "t", ownerId: ada.id, ownerName: ada.name }),
    ev({ type: "lane.added", lane: { id: "lw", name: "Writer", agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } }),
    ev({ type: "lane.added", lane: { id: "lb", name: "Builder", agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } }),
    ev({ type: "board.posted", fromLane: MAIN_LANE, fromName: "Main", tasks: [{ id: "a", title: "A", detail: "a", owns: [], after: [] }] }, MAIN_LANE, bot("Main")),
    ev({ type: "board.claimed", id: "a", lane: "lw", name: "Writer" }, "lw", bot("Writer")),
    ev({ type: "run.started", causedBy: 1 }, "lw", bot("Writer")),
  ];
  const note = { id: "x", kind: "task" as const, fromLane: MAIN_LANE, fromName: "Main", toName: "Writer", hop: 1, by: null, board: "a" };
  const at = (more: object[]) => taskStatus(project("s", [...base, ...more.map((b) => ev(b as EventBody, (b as { lane?: string }).lane ?? "lw", bot("Writer")))]), note, "lw");
  assert.deepEqual(at([]), { word: "Writer is on it", how: "work" });
  assert.deepEqual(at([{ type: "run.ended", outcome: "error", error: "usage limit" }]), { word: "Writer stopped", how: "bad" });
  assert.equal(at([{ type: "run.ended", outcome: "error", error: "x" }, { type: "board.released", id: "a", why: "out of usage" }, { type: "board.claimed", id: "a", lane: "lb", name: "Builder" }]).word, "Moved to Builder");
  assert.equal(at([{ type: "board.finished", id: "a", lane: "lw", name: "Writer", status: "done", report: "ok" }, { type: "board.review", id: "a", lane: "lb", name: "Builder" }]).word, "Builder is checking it");
  assert.equal(at([{ type: "board.finished", id: "a", lane: "lw", name: "Writer", status: "done", report: "ok" }, { type: "board.reviewed", id: "a", lane: "lb", name: "Builder", ok: true, note: "Approved." }]).word, "Done and checked");
});
