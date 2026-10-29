import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentMesh } from "../src/agent-mesh.js";
import { backNote, limitedLanes, limitedTask, limitTargets, stillLimited } from "../src/limit-handoff.js";
import { nearLimit } from "../src/routing.js";
import { project, type LaneEngine, type SessionState } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/** Arun, 2026-10-20: "auto hand off if a coding tool hits its limit, make it smart". */

const ada: ActorRef = { id: "u-ada", name: "Ada", kind: "human" };
const tool: ActorRef = { id: "engine", name: "Claude Code", kind: "agent" };
const friday: ActorRef = { id: "friday", name: "Friday", kind: "system" };
const NOW = Date.UTC(2026, 9, 20, 12);

function log(rows: [ActorRef, EventBody, string?, number?][]): SessionEvent[] {
  return rows.map(([actor, body, lane, ts], i) => ({ seq: i + 1, ts: ts ?? NOW - 60_000, actor, body, ...(lane && lane !== MAIN_LANE ? { lane } : {}) }) as SessionEvent);
}
const laneDef = (id: string, name: string, over: Record<string, unknown> = {}) => ({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" }, ...over } }) as EventBody;
const engine = (over: Partial<LaneEngine>): LaneEngine => ({ tool: "claude", hostId: ada.id, hostName: "Ada", cwd: "/w/shop", online: true, sinceSeq: 0, mode: "edits", ...over }) as LaneEngine;
const limited: EventBody = { type: "run.ended", outcome: "error", error: "Claude AI usage limit reached. Try again in 2 hours." };

function session(engines: Record<string, LaneEngine>, more: [ActorRef, EventBody, string?, number?][] = []): [SessionState, SessionEvent[]] {
  const events = log([
    [ada, { type: "session.created", title: "t", ownerId: ada.id, ownerName: ada.name }],
    [ada, laneDef("lc", "Claude")],
    [ada, laneDef("lx", "Codex")],
    [ada, laneDef("lw", "Watcher", { control: { kind: "standing" } })],
    [ada, { type: "instruction", text: "Fix the cart total.", interrupt: false }, "lc"],
    [tool, { type: "run.started", causedBy: 5 }, "lc"],
    [tool, { type: "instructions.delivered", seqs: [5] }, "lc"],
    [friday, { type: "instruction", text: "Keep going", interrupt: false, keepGoing: true }, "lc"],
    [tool, { type: "instructions.delivered", seqs: [8] }, "lc"],
    [tool, limited, "lc"],
    ...more,
  ]);
  const s = project("s", events);
  return [{ ...s, engines }, events];
}

test("out of usage: another tool in the same code, free first; never the same tool, someone else's own plan, one also out, offline, or on its own triggers", () => {
  const codex = engine({ tool: "codex" });
  const [s, e] = session({ lc: engine({}), lx: codex });
  assert.deepEqual(limitTargets(s, e, "lc", NOW).map((t) => t.id), ["lx", MAIN_LANE], "Codex, free and on its own subscription, then Friday Code (borrowing the folder)");
  assert.match(limitTargets(s, e, "lc", NOW)[0]!.why, /Codex is free/);

  // Never the same tool: on this computer it is the same sign-in, out too; anywhere else, carrying on as another sign-in is getting
  // round the tool's usage limit (Arun, 2026-10-27: "i do not want my account banned").
  const [same, e2] = session({ lc: engine({}), lx: engine({}) });
  assert.ok(!limitTargets(same, e2, "lc", NOW).some((t) => t.id === "lx"));
  const [theirs, e3] = session({ lc: engine({}), lx: engine({ hostId: "u-bo", hostName: "Bo" }) });
  assert.ok(!limitTargets(theirs, e3, "lc", NOW).some((t) => t.id === "lx"), "not a teammate's Claude Code either");
  // A teammate's other tool on their own plan takes their work alone (own-plan.ts): Ada's task never goes to Bo's Codex. Bo's
  // Codex on an API key Bo shares may take it.
  const [bos, e3b] = session({ lc: engine({}), lx: engine({ tool: "codex", hostId: "u-bo", hostName: "Bo" }) });
  assert.ok(!limitTargets(bos, e3b, "lc", NOW).some((t) => t.id === "lx"), "not Bo's Codex on Bo's ChatGPT plan");
  const [keyed, e3c] = session({ lc: engine({}), lx: engine({ tool: "codex", hostId: "u-bo", hostName: "Bo", apiKey: true }) });
  assert.ok(limitTargets(keyed, e3c, "lc", NOW).some((t) => t.id === "lx"), "Bo's Codex on Bo's API key");

  // Offline, or in another project: can't carry this on.
  const [away, e4] = session({ lc: engine({}), lx: engine({ tool: "codex", online: false }) });
  assert.ok(!limitTargets(away, e4, "lc", NOW).some((t) => t.id === "lx"));
  const [elsewhere, e5] = session({ lc: engine({}), lx: engine({ tool: "codex", cwd: "/w/blog" }) });
  assert.ok(!limitTargets(elsewhere, e5, "lc", NOW).some((t) => t.id === "lx"));
  assert.ok(!limitTargets(s, e, "lc", NOW).some((t) => t.id === "lw"), "a standing agent takes no hand-offs");

  // One that is itself out of usage until later.
  const [both, e6] = session({ lc: engine({}), lx: codex }, [[tool, { type: "run.started", causedBy: 5 }, "lx"], [tool, { type: "run.ended", outcome: "error", error: "You've hit your usage limit. Try again in 3 hours." }, "lx"]]);
  assert.ok(!limitTargets(both, e6, "lc", NOW).some((t) => t.id === "lx"));
  assert.ok(stillLimited(e6, "lx", NOW));
  assert.ok(!stillLimited(e6, "lx", NOW + 4 * 3_600_000), "until its limit lifts");
});

test("a busy agent comes after a free one, and the task handed on is what the run was asked, not Friday's nudges", () => {
  const [s, e] = session({ lc: engine({}), lx: engine({ tool: "codex" }) }, [[tool, { type: "run.started", causedBy: 5 }, "lx"]]);
  assert.deepEqual(limitTargets(s, e, "lc", NOW).map((t) => t.id), [MAIN_LANE, "lx"]);
  assert.match(limitTargets(s, e, "lc", NOW)[1]!.why, /takes it after what it is doing/);
  assert.equal(limitedTask(e, "lc", 6, 10), "Ada: Fix the cart total.");
});

test("with nobody to take it, it carries on by itself when the limit lifts, as the person who asked; and only once", async () => {
  const [state, events] = session({ lc: engine({}) });
  const lone = { ...state, lanes: state.lanes.filter((l) => l.id === "lc"), driver: null };
  const appended: { actor: ActorRef; body: EventBody; lane?: string }[] = [];
  const store = {
    state: async () => lone,
    events: async () => events,
    append: async (_sid: string, actor: ActorRef, body: EventBody, o: { lane?: string }) => (appended.push({ actor, body, ...(o.lane ? { lane: o.lane } : {}) }), { ok: true, seq: 99 }),
  };
  const mesh = new AgentMesh(store as never, null as never, async () => ({ ok: false as const, error: "nobody" }));
  await mesh.onLimit("s", "lc", NOW);
  assert.equal(appended.length, 1);
  const r = appended[0]!;
  assert.equal(r.body.type, "resume.scheduled");
  assert.equal(r.actor.id, ada.id, "as Ada, who asked for the run");
  assert.equal(r.lane, "lc");
  if (r.body.type === "resume.scheduled") {
    assert.equal(r.body.auto, true);
    assert.ok(Math.abs(r.body.at - (events.at(-1)!.ts + 2 * 3_600_000)) < 1000, "when the limit said it lifts");
  }
  // Already set: not again.
  events.push({ seq: 11, ts: NOW, actor: ada, body: { type: "resume.scheduled", at: NOW + 1, auto: true }, lane: "lc" } as SessionEvent);
  await mesh.onLimit("s", "lc", NOW);
  assert.equal(appended.length, 1);
});

/** Arun, 2026-10-25: "maximum performance smart routing of tasks to other agents when usage limit hits". */
test("an agent on the same tool, computer and sign-in as one out of usage is out too, until it finishes a run again", () => {
  const extra: [ActorRef, EventBody, string?, number?][] = [[ada, laneDef("l2", "Claude 2")], [ada, laneDef("lb", "Bo's Claude")], [ada, laneDef("la", "Work Claude")]];
  const engines = { lc: engine({}), l2: engine({}), lb: engine({ hostId: "u-bo", hostName: "Bo" }), la: engine({ account: { id: "work", label: "Work" } }), lx: engine({ tool: "codex" }) };
  const [s, e] = session(engines, extra);
  const out = limitedLanes(s, e, NOW);
  assert.deepEqual([...out.keys()].sort(), ["l2", "lc"]);
  assert.equal(out.get("l2")!.via, "lc", "out because Claude hit it");
  assert.ok(out.get("lc")!.until! > NOW, "with when it lifts");
  assert.ok(!limitTargets(s, e, "lc", NOW).some((t) => t.id === "l2"), "never handed the task Claude couldn't finish");
  assert.equal(limitedLanes(s, e, NOW + 3 * 3_600_000).size, 0, "the limit lifted");
  // Claude 2 finished a run since: it isn't out (another account after all, or the limit was lifted).
  const [s2, e2] = session(engines, [...extra, [tool, { type: "run.started", causedBy: 5 }, "l2", NOW - 30_000], [tool, { type: "run.ended", outcome: "done" }, "l2", NOW - 20_000]]);
  assert.ok(!limitedLanes(s2, e2, NOW).has("l2"));
});

test("the others hear an agent is out of usage, and until when, and aren't let message it, but told who is free", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const extra: [ActorRef, EventBody, string?, number?][] = [
    [ada, laneDef("l2", "Claude 2")],
    [ada, { type: "instruction", text: "Ship the checkout.", interrupt: false }, "lx"],
    [tool, { type: "run.started", causedBy: 12 }, "lx"],
    [tool, { type: "instructions.delivered", seqs: [12] }, "lx"],
  ];
  const [state, events] = session({ lc: engine({}), l2: engine({}), lx: engine({ tool: "codex" }) }, extra);
  const appended: EventBody[] = [];
  const store = { state: async () => state, events: async () => events, append: async (_s: string, _a: ActorRef, body: EventBody) => (appended.push(body), { ok: true, seq: 99 }) };
  const mesh = new AgentMesh(store as never, { wake: async () => {} } as never, async () => ({ ok: false as const, error: "nobody" }));
  const listed = await mesh.list("s", "lx", NOW);
  assert.match(listed, /"Claude": .*out of usage until its limit lifts in about 2 hours: can't take messages or tasks until then/);
  assert.match(listed, /"Claude 2": .*out of usage .*as the same Claude Code account as Claude, which hit it/);
  const sent = await mesh.send("s", "lx", { to: "Claude", text: "Can you check the totals?", kind: "ask" });
  assert.equal(sent.ok, false);
  if (!sent.ok) assert.match(sent.error, /Claude is out of usage until its limit lifts in about 2 hours, so it can't take this until then\. Free now: "Main/);
  assert.ok(!appended.some((b) => b.type === "instruction"), "nothing sent to wake it only to fail");
});

test("an agent nearly out of usage is said to be, and comes after one with room", () => {
  assert.equal(nearLimit([{ kind: "five_hour", label: "5-hour", usedPercent: 60 }]), null);
  assert.deepEqual(nearLimit([{ kind: "five_hour", label: "5-hour", usedPercent: 93.4 }, { kind: "weekly", label: "weekly", usedPercent: 97 }]), { pct: 97, label: "weekly" }, "the fullest");
  const soon = Math.round((Date.now() + 10 * 60_000) / 1000);
  assert.equal(nearLimit([{ kind: "five_hour", label: "5-hour", usedPercent: 95, resetsAt: soon }]), null, "one starting over in minutes has room");
});

test("back from its limit, an agent hears what was handed on while it was out, so it doesn't redo it", () => {
  const [s, e] = session({ lc: engine({}), lx: engine({ tool: "codex" }) }, [
    [friday, { type: "instruction", text: "Fix the cart total.", interrupt: false, handoff: { fromLane: "lc", fromName: "Claude", toName: "Codex", reason: "out of usage", carried: [] } } as EventBody, "lx"],
    [tool, { type: "run.started", causedBy: 11 }, "lx"],
    [tool, { type: "run.ended", outcome: "done" }, "lx"],
  ]);
  assert.equal(backNote(s, e, "lc", NOW), "", "nothing while it is still out");
  const note = backNote(s, e, "lc", NOW + 3 * 3_600_000);
  assert.match(note, /You ran out of usage about 3 hours ago, partway through what you were doing; your limit has lifted/);
  assert.match(note, /Don't redo it[\s\S]*- Codex took over "Fix the cart total\." and has finished a turn on it since\./);
  assert.equal(backNote(s, e, "lx", NOW + 3 * 3_600_000), "", "and nothing for one that wasn't out");
});

/** Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes". */
test("a tool that isn't signed in hands its task on as one out of usage does, and with nobody to take it schedules nothing", async () => {
  const run = (engines: Record<string, LaneEngine>) => {
    const [state, events] = session(engines);
    events[9] = { ...events[9]!, body: { type: "run.ended", outcome: "error", error: "Claude Code isn't signed in on the computer it runs on, or its login has expired." } } as SessionEvent;
    const appended: EventBody[] = [];
    const handed: { to: string; reason: string; task: string }[] = [];
    const store = { state: async () => state, events: async () => events, append: async (_s: string, _a: ActorRef, body: EventBody) => (appended.push(body), { ok: true, seq: 99 }) };
    const mesh = new AgentMesh(store as never, null as never, async (_sid: string, _lane: string, h: { to: string; reason: string; task: string }) => (handed.push(h), { ok: true as const, toName: h.to }));
    return { mesh, appended, handed };
  };
  const two = run({ lc: engine({}), lx: engine({ tool: "codex" }) });
  await two.mesh.onLimit("s", "lc", NOW);
  assert.equal(two.handed.length, 1, "handed on");
  assert.match(two.handed[0]!.reason, /isn't signed in/);
  assert.match(two.handed[0]!.task, /Fix the cart total/);
  const lone = run({ lc: engine({}) });
  (await lone.mesh.onLimit("s", "lc", NOW), assert.equal(lone.appended.length, 0, "no resume: nothing brings a sign-in back by itself"));
});
