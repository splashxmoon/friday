import assert from "node:assert/strict";
import { test } from "node:test";
import { leftOff } from "../src/left-off.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

let n = 0;
const log: SessionEvent[] = [];
const ev = (body: EventBody, who = "Ada", lane?: string, kind: "human" | "agent" = "human"): SessionEvent => {
  const e = { seq: ++n, ts: n * 1000, actor: { id: who.toLowerCase(), name: who, kind } as SessionEvent["actor"], body, ...(lane ? { lane } : {}) };
  log.push(e);
  return e;
};
const plan = (steps: { title: string; status: string }[]) => ({ id: "p1", name: "update_plan", arguments: JSON.stringify({ steps }) });
const state = () => project("s", log);
const reset = () => ((n = 0), (log.length = 0));

test("a session with nothing in it says nothing", () => {
  reset();
  ev({ type: "session.created", title: "Empty", ownerId: "ada", ownerName: "Ada" }, "System");
  const l = leftOff(state(), log);
  assert.ok(!l.sections.some((s) => s.label === "Where it stands"));
  assert.match(l.markdown, /^# Where we left off: Empty/);
});

test("it reads the goal, the state, the changes and what is open out of the log", () => {
  reset();
  ev({ type: "session.created", title: "Upgrade pg", ownerId: "ada", ownerName: "Ada" }, "System");
  const ask = ev({ type: "instruction", text: "Upgrade the pg client to v9 and keep the tests green", interrupt: false });
  ev({ type: "run.started", causedBy: ask.seq }, "Friday", undefined, "agent");
  ev({ type: "agent.message", text: "Bumped the dependency.\n\nTwo tests still fail.", toolCalls: [plan([{ title: "Bump pg", status: "completed" }, { title: "Fix the failing tests", status: "pending" }, { title: "Update docs", status: "pending" }])] }, "Friday", undefined, "agent");
  ev({ type: "folder.edited", path: "package.json", bytes: 10 });
  ev({ type: "folder.ran", command: "npm test", output: "2 failed", isError: true });
  ev({ type: "thread.opened", id: "t1", path: "src/db.ts", line: 40, code: "x", text: "Use the pool here", removed: false } as EventBody, "Bo");
  ev({ type: "run.ended", outcome: "done" }, "Friday", undefined, "agent");
  const l = leftOff(state(), log);
  const by = Object.fromEntries(l.sections.map((s) => [s.label, s.items.join(" | ")]));
  assert.match(by["The task"]!, /Ada asked: Upgrade the pg client to v9/);
  assert.match(by["Where it stands"]!, /Friday Code finished its last run\. Its last words: “Bumped the dependency\.”/);
  assert.match(by["What changed"]!, /1 file touched: package\.json \(edited\)/);
  assert.match(by["What changed"]!, /Nothing committed yet/);
  assert.match(by["Still open"]!, /plan has 2 of 3 steps left: Fix the failing tests; Update docs/);
  assert.match(by["Still open"]!, /1 open review comment: src\/db\.ts:40 “Use the pool here”/);
  assert.match(by["Still open"]!, /`npm test` last failed/);
  assert.match(by["Start with"]!, /Fix what failed: `npm test`/);
  assert.match(l.markdown, /## Still open\n- /);
});

test("a command that failed and then passed is not open, and a resolved comment is not either", () => {
  reset();
  ev({ type: "session.created", title: "t", ownerId: "ada", ownerName: "Ada" }, "System");
  ev({ type: "folder.ran", command: "npm test", output: "x", isError: true });
  ev({ type: "folder.ran", command: "npm test", output: "ok" });
  ev({ type: "thread.opened", id: "t1", path: "a.ts", line: 1, code: "", text: "hm", removed: false } as EventBody, "Bo");
  ev({ type: "thread.resolved", id: "t1" });
  const l = leftOff(state(), log);
  assert.ok(!l.markdown.includes("last failed"));
  assert.ok(!l.markdown.includes("review comment"));
});

test("a waiting question comes first, and decisions are kept", () => {
  reset();
  ev({ type: "session.created", title: "t", ownerId: "ada", ownerName: "Ada" }, "System");
  ev({ type: "plan.approved", steps: ["Do A", "Do B"] });
  ev({ type: "memory.saved", key: "k", text: "We chose Postgres over Mongo." }, "Friday", undefined, "agent");
  ev({ type: "agent.question", callId: "c", question: "Which region?", to: "bo", toName: "Bo" }, "Friday", undefined, "agent");
  const l = leftOff(state(), log);
  const by = Object.fromEntries(l.sections.map((s) => [s.label, s.items.join(" | ")]));
  assert.match(by["Decided along the way"]!, /Ada approved the plan with changes: 1\. Do A 2\. Do B/);
  assert.match(by["Decided along the way"]!, /We chose Postgres over Mongo/);
  assert.match(by["Start with"]!, /Answer the agent's question: “Which region\?”/);
  assert.match(by["Still open"]!, /Bo has an unanswered question/);
});

test("a commit says whether it went anywhere, and later changes are called out", () => {
  reset();
  ev({ type: "session.created", title: "t", ownerId: "ada", ownerName: "Ada" }, "System");
  ev({ type: "folder.edited", path: "a.ts", bytes: 1 });
  ev({ type: "folder.committed", sha: "abcdef1234567", files: 1, branch: "fix/x", pushed: true, prUrl: "https://github.com/o/r/pull/9" } as EventBody);
  ev({ type: "folder.edited", path: "b.ts", bytes: 1 });
  const by = Object.fromEntries(leftOff(state(), log).sections.map((s) => [s.label, s.items.join(" | ")]));
  assert.match(by["What changed"]!, /Last commit abcdef1 on fix\/x, pushed\. Pull request: https:\/\/github\.com\/o\/r\/pull\/9/);
  assert.match(by["What changed"]!, /1 file changed since then and not committed/);
  assert.match(by["Start with"]!, /Review what changed since the last commit/);
});
