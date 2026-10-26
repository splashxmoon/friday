import assert from "node:assert/strict";
import test from "node:test";
import { promptFor } from "../src/engine/hub.js";
import { handoffBrief, pathsReadBy } from "../src/handoff.js";
import type { EventBody, SessionEvent } from "../src/types.js";

/**
 * A handoff that carries what the first agent already knows.
 *
 * Codex read the training code and the validation results, found the depth-4 candidate had already been rejected, and wrote
 * a plan; handed to Kiro with a reason and two short lines, Kiro read every file again to find out the same thing. The brief
 * is that record: what it was asked, what it read, ran and searched, what it changed and noticed, and its whole answer.
 */

let seq = 0;
const ev = (actor: SessionEvent["actor"], body: EventBody, lane = "codex"): SessionEvent => ({ seq: ++seq, ts: Date.now(), actor, body, lane });
const ada = { id: "ada", name: "Ada", kind: "human" as const };
const codex = { id: "engine:h1", name: "Ada's Codex", kind: "agent" as const };
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });

const PLAN = `The depth-4 candidate was already validated and rejected on October 12.

| Recorded metric | Depth-3 baseline | Depth-4 candidate |
|---|---|---|
| LOCO recall | 69.37% | 75.39% |
| Fall22 AUC | 0.9582 | 0.9471 |

My plan:
1. Establish reproducible baselines in ml/benchmark_loco.py.
2. A small tuning pass in ml/tune_model.py.`;

function session(): SessionEvent[] {
  seq = 0;
  return [
    ev(ada, { type: "instruction", text: "improve model accuracy and performance, plan first", interrupt: false }),
    ev(codex, { type: "run.started", causedBy: 1 }),
    ev(codex, { type: "agent.message", text: "I'll read the training code and validation results first.", toolCalls: [call("c1", "shell", { command: "Get-Location; rg --files -g AGENTS.md -g '*train*'" })] }),
    ev(codex, { type: "tool.result", callId: "c1", name: "shell", output: "rg: not found", isError: true }),
    ev(codex, { type: "agent.message", text: "", toolCalls: [call("c2", "shell", { command: "Get-Content ml\\model_def.py; Get-Content -Raw ml/EVALUATION.md" }), call("c3", "read", { path: "ml/candidate_validation.json" })] }),
    ev(codex, { type: "tool.result", callId: "c2", name: "shell", output: "…", isError: false }),
    ev(codex, { type: "tool.result", callId: "c3", name: "read", output: "…", isError: false }),
    ev(codex, { type: "agent.message", text: "There's a completed validation result dated October 12, so the earlier note may be stale.", toolCalls: [call("c4", "search", { pattern: "max_depth", path: "ml" })] }),
    ev(codex, { type: "tool.result", callId: "c4", name: "search", output: "…", isError: false }),
    ev(codex, { type: "agent.diff", base: "abc", files: [{ path: "ml/notes.md", status: "modified", additions: 2, deletions: 0, patch: "@@ -1 +1,3 @@\n # Notes\n+Depth-4 rejected on Oct 12.\n+Next: benchmark first." }] }),
    ev(codex, { type: "agent.message", text: PLAN, toolCalls: [] }),
    ev(codex, { type: "run.ended", outcome: "done" }),
  ];
}

test("the brief carries the whole answer, what was read, run and searched, and what changed", () => {
  const events = session();
  const brief = handoffBrief(events, "codex", seq + 1);
  assert.ok(brief.includes(PLAN), "its answer whole, table and plan included, not the first line of it");
  assert.match(brief, /improve model accuracy and performance, plan first/, "what it was asked");
  for (const p of ["ml/model_def.py", "ml/EVALUATION.md", "ml/candidate_validation.json"]) assert.ok(brief.includes(`- ${p}`), `read: ${p}`);
  assert.match(brief, /max_depth in ml/, "its search");
  assert.match(brief, /failed: Get-Location; rg --files/, "a command that failed is said to have failed");
  assert.match(brief, /ok: Get-Content ml\\model_def\.py/, "and one that worked, that it worked");
  assert.match(brief, /ml\/notes\.md \(modified, \+2 −0\)/);
  assert.match(brief, /\+Depth-4 rejected on Oct 12\./, "the change itself, small enough to carry");
  assert.match(brief, /earlier note may be stale/, "what it noticed along the way");
  assert.match(brief, /don't reopen these/, "and the instruction not to read them all again");
});

test("the handoff prompt puts the brief between why and the task", () => {
  const events = session();
  events.push(
    ev(ada, {
      type: "instruction",
      text: "Pick up from Codex's work and carry on.",
      interrupt: false,
      handoff: { fromLane: "codex", fromName: "Codex", toName: "Kiro", reason: "Codex finished its part. Kiro takes it from here.", carried: [] },
    }, "kiro"),
  );
  const { prompt } = promptFor(events, [seq]);
  const why = prompt.indexOf("Why: Codex finished");
  const record = prompt.indexOf("What Codex already did");
  const task = prompt.indexOf("The task: Pick up");
  assert.ok(why >= 0 && record > why && task > record, "why, then the record, then the task");
  assert.match(prompt, /don't re-read files or re-run commands to rediscover it/);
});

test("nothing done yet, nothing carried; and only this agent's own recent work", () => {
  seq = 0;
  const idle = [ev(ada, { type: "instruction", text: "hello", interrupt: false })];
  assert.equal(handoffBrief(idle, "codex", seq + 1), "");
  // Another lane's reading is not this agent's.
  const events = session();
  events.push(ev(codex, { type: "agent.message", text: "", toolCalls: [call("x1", "read", { path: "other/lane.ts" })] }, "claude"));
  assert.ok(!handoffBrief(events, "codex", seq + 1).includes("other/lane.ts"));
});

test("the files a shell command reads", () => {
  assert.deepEqual(pathsReadBy("Get-Content ml\\model_def.py; Get-Content -Raw ml/EVALUATION.md"), ["ml/model_def.py", "ml/EVALUATION.md"]);
  assert.deepEqual(pathsReadBy("sed -n '1,80p' src/app.ts && head -n 20 README.md"), ["src/app.ts", "README.md"]);
  assert.deepEqual(pathsReadBy("rg -n 'max_depth' ml/tune_model.py"), ["ml/tune_model.py"]);
  assert.deepEqual(pathsReadBy("npm test"), [], "running something is not reading a file");
  assert.deepEqual(pathsReadBy("rg --files -g '*train*'"), [], "a pattern is not a file");
});
