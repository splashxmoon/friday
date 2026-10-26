import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDigest } from "../src/session/digest.js";
import { initialState } from "../src/session/projection.js";
import type { Member, SessionEvent } from "../src/types.js";

const ME: Member = { id: "me", name: "Arun", role: "owner" };
const other = { id: "sam", name: "Sam", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

function state(patch: Partial<ReturnType<typeof initialState>> = {}) {
  return { ...initialState("s1"), ...patch };
}

const ev = (seq: number, actor: typeof other | typeof agent, body: SessionEvent["body"], ts = seq * 1000): SessionEvent =>
  ({ seq, ts, actor, body }) as SessionEvent;

test("a digest of only your own events is nothing to catch up on", () => {
  const mine = [ev(1, { ...other, id: "me", name: "Arun" }, { type: "instruction", text: "go", interrupt: false, attachments: [] })];
  assert.equal(buildDigest(mine, state(), ME, 0), null);
});

test("groups what the team did and what the agent did, separately", () => {
  const missed = [
    ev(2, other, { type: "instruction", text: "Look at pricing", interrupt: false, attachments: [] }),
    ev(3, other, { type: "instruction", text: "And churn", interrupt: false, attachments: [] }),
    ev(5, agent, { type: "tool.result", callId: "c1", name: "web_search", output: "ok", isError: false }),
  ];
  const d = buildDigest(missed, state(), ME, 1)!;
  assert.equal(d.missed, 3);
  assert.equal(d.since, 2000, "dates the start of the gap");

  const team = d.groups.find((g) => g.label === "The team")!;
  assert.ok(
    team.items.some((i) => i.includes("Sam") && i.includes("2 instructions")),
    "collapses repeated instructions per person",
  );

  const byAgent = d.groups.find((g) => g.label === "The agent")!;
  assert.ok(byAgent.items.some((i) => i.includes("web_search") || i.includes("1 tool")), `agent items were ${byAgent.items.join(" | ")}`);
  assert.ok(byAgent.items.some((i) => i.includes("1 tool call")));
});

test("what is blocking you is separated from general activity", () => {
  const s = state({ openQuestions: { main: { seq: 9, lane: "main", question: "Red or blue?", to: "me", toName: "Arun" } } });
  const d = buildDigest([ev(2, agent, { type: "agent.question", callId: "c", question: "Red or blue?", to: "me", toName: "Arun" })], s, ME, 1)!;
  assert.equal(d.needsYou.length, 1);
  assert.match(d.needsYou[0]!, /waiting on your answer/);

  // The same question aimed at someone else is activity, not a block.
  const theirs = state({ openQuestions: { main: { seq: 9, lane: "main", question: "Red or blue?", to: "sam", toName: "Sam" } } });
  const d2 = buildDigest([ev(2, agent, { type: "agent.question", callId: "c", question: "Red or blue?", to: "sam", toName: "Sam" })], theirs, ME, 1)!;
  assert.deepEqual(d2.needsYou, []);

  // Two agents waiting on you are two answers you owe, not one.
  const both = state({
    openQuestions: {
      main: { seq: 9, lane: "main", question: "Red or blue?", to: "me", toName: "Arun" },
      l1: { seq: 11, lane: "l1", question: "Round or square?", to: "me", toName: "Arun" },
    },
  });
  const d3 = buildDigest([ev(2, agent, { type: "agent.question", callId: "c", question: "Red or blue?", to: "me", toName: "Arun" })], both, ME, 1)!;
  assert.equal(d3.needsYou.length, 2);
  assert.match(d3.needsYou[1]!, /Round or square/);
});

test("a failed run and pending control requests surface as needing you", () => {
  const s = state({
    run: { status: "error", sinceSeq: 4, error: "Model provider error" },
    driver: { id: "me", name: "Arun" },
    pendingRequests: [{ id: "sam", name: "Sam", seq: 3, lane: "main" }],
  });
  const d = buildDigest([ev(2, other, { type: "control.requested" } as SessionEvent["body"])], s, ME, 1)!;
  assert.ok(d.needsYou.some((n) => n.includes("asking for control")));
  assert.ok(d.needsYou.some((n) => n.includes("stopped on an error")));
});

test("the flat lines keep every fact the groups carry", () => {
  const missed = [
    ev(2, other, { type: "instruction", text: "Look at pricing", interrupt: false, attachments: [] }),
  ];
  const d = buildDigest(missed, state(), ME, 1)!;
  const flat = d.lines.join("\n");
  assert.ok(flat.includes("Sam sent 1 instruction"));
  assert.ok(flat.includes("driving"), "always states who holds the wheel");
});

test("with several agents, a line each: who answered, changed files, finished tasks or stopped", () => {
  const lane = { id: "lc", name: "Claude Code", control: { kind: "open" as const }, trigger: { kind: "manual" as const } };
  const s = state({ lanes: [lane] as never, mainName: "Friday" });
  const inLane = (e: SessionEvent, l?: string) => (l ? { ...e, lane: l } : e);
  const missed = [
    inLane(ev(2, agent, { type: "agent.message", text: "Done with the API", toolCalls: [] })),
    inLane(ev(3, agent, { type: "agent.diff", base: "b", files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } as never), "lc"),
    inLane(ev(4, agent, { type: "agent.message", text: "Tests pass", toolCalls: [] }), "lc"),
    inLane(ev(5, agent, { type: "run.ended", outcome: "error", error: "boom" }), "lc"),
    ev(6, agent, { type: "mesh.posted", id: "m1", fromLane: "lc", fromName: "Claude Code", text: "API is ready" }),
  ];
  const d = buildDigest(missed, s, ME, 1)!;
  const agents = d.groups.find((g) => g.label === "The agents")!;
  assert.ok(agents, `groups were ${d.groups.map((g) => g.label).join(", ")}`);
  assert.ok(agents.items.includes("Friday answered once"), agents.items.join(" | "));
  assert.ok(agents.items.includes("Claude Code answered once, changed 2 files, stopped on an error"), agents.items.join(" | "));
  assert.ok(agents.items.includes("The agents sent each other 1 message"), agents.items.join(" | "));
});
