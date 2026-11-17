// Several agents in one thread (TeamCard.tsx, catchup.ts missedSince, lane-at.ts groupAt): the lead's team card, what an agent
// turned to is told it missed, and @all / @idle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { span, teamsIn } from "../src/client/team-thread.js";
import { missedSince, missedText } from "../src/session/catchup.js";
import { groupAt } from "../src/client/lane-at.js";
import type { EventBody, SessionEvent } from "../src/types.js";

let seq = 0;
const ev = (body: Partial<EventBody> & { type: string }, lane?: string, human = false): SessionEvent =>
  ({ seq: ++seq, ts: seq * 1000, actor: human ? { id: "ada", name: "Ada", kind: "human" } : { id: "engine:x", name: "Agent", kind: "agent" }, body: body as EventBody, ...(lane && lane !== "main" ? { lane } : {}) }) as SessionEvent;
const task = (from: string, to: string, text = `${to}'s part`) => ev({ type: "instruction", text, mesh: { id: `t${seq + 1}`, kind: "task", fromLane: from, fromName: from, toName: to, hop: 1, by: null } } as never, to);
const report = (from: string, to: string, re: string) => ev({ type: "instruction", text: "done", mesh: { id: `r${seq + 1}`, kind: "reply", ofTask: true, re, fromLane: from, fromName: from, toName: to, hop: 1, by: null } } as never, to);
const person = (text: string, lane?: string) => ev({ type: "instruction", text } as never, lane, true);
const all = () => true;
const idOf = (e: SessionEvent) => (e.body as { mesh: { id: string } }).mesh.id;

test("the lead handing work to two agents is one team, drawn at the first task, with the reports folded in", () => {
  seq = 0;
  person("Fix checkout");
  const a = task("main", "codex");
  const b = task("main", "cursor");
  const r = report("codex", "main", idOf(a));
  const teams = teamsIn([person("x"), a, b, r], all);
  assert.equal(teams.get(a.seq), teams.get(b.seq));
  assert.equal(teams.get(a.seq)!.anchor, a.seq);
  assert.equal(teams.get(r.seq), teams.get(a.seq), "the report is in the card, not a card of its own");
});

test("one task alone stays a huddle, and a person's message starts a new round", () => {
  seq = 0;
  const a = task("main", "codex");
  const p = person("And now the receipts");
  const b = task("main", "cursor");
  assert.equal(teamsIn([a, p, b], all).size, 0);
  assert.equal(teamsIn([a, task("main", "codex", "a second part")], all).size, 0, "two tasks to the same agent are not a team");
});

const ran = (lane: string, said: string, files: string[], outcome: "done" | "error" = "done") => [
  ev({ type: "run.started", causedBy: 0 } as never, lane),
  ev({ type: "agent.message", text: said, toolCalls: [] } as never, lane),
  ...(files.length ? [ev({ type: "agent.diff", base: "x", files: files.map((path) => ({ path, status: "modified", additions: 1, deletions: 0 })) } as never, lane)] : []),
  ev({ type: "run.ended", outcome } as never, lane),
];
const state = { engines: { main: { tool: "claude" }, codex: { tool: "codex" } }, lanes: [{ id: "codex", name: "Codex" }] } as never;

test("an agent turned to is told what the others finished since its last turn, and only that", () => {
  seq = 0;
  const first = person("Start", "codex");
  const delivered = ev({ type: "instructions.delivered", seqs: [first.seq] } as never, "codex");
  const before = ran("main", "Old work", ["old.ts"]);
  const codexRun = ran("codex", "Set up", []);
  const delivered2 = ev({ type: "instructions.delivered", seqs: [99] } as never, "codex");
  const claude = ran("main", "Fixed: tax is added once now.", ["src/totals.ts", "src/cart.ts"]);
  const failed = ran("main", "Half done", ["x.ts"], "error");
  const ask = person("Now add a test for the rounding", "codex");
  const events = [first, delivered, ...before, ...codexRun, delivered2, ...claude, ...failed, ask];
  const missed = missedSince(state, events, "codex", [ask.seq]);
  assert.equal(missed.length, 1, "only the run that finished since its last turn, not one that failed");
  assert.equal(missed[0]!.name, "Claude Code");
  assert.deepEqual(missed[0]!.files, ["src/totals.ts", "src/cart.ts"]);
  const text = missedText(missed);
  assert.match(text, /Claude Code: Fixed: tax is added once now\. Changed: src\/totals\.ts, src\/cart\.ts\./);
  assert.equal(missedText([]), "");
});

test("an agent's first turn has nothing it missed: its catch-up has it all", () => {
  seq = 0;
  const events = [...ran("main", "Did a thing", ["a.ts"]), person("Hi", "codex")];
  assert.deepEqual(missedSince(state, events, "codex", [events.at(-1)!.seq]), []);
});

test("the team card's clock", () => {
  assert.equal(span(100_000), "1:40");
  assert.equal(span(3_840_000), "1h 4m");
});

test("@all and @idle at the start name a group; elsewhere, or alone, they don't", () => {
  assert.deepEqual(groupAt("@all fix the lint"), { group: "all", text: "fix the lint" });
  assert.deepEqual(groupAt("  @IDLE, pick up the tests"), { group: "idle", text: "pick up the tests" });
  assert.equal(groupAt("@allison look"), null);
  assert.equal(groupAt("tell @all"), null);
  assert.equal(groupAt("@all"), null);
});
