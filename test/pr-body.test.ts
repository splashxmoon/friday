import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { plainCommitMessage, prBodyFor } from "../src/pr-body.js";
import { SessionCore } from "../src/session/core.js";
import { project } from "../src/session/projection.js";
import { SessionStore } from "../src/session/store.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const ada = { id: "u-ada", name: "Ada" };
const human = (name: string) => ({ id: name, name, kind: "human" as const });
const agent = (name: string) => ({ id: `engine:${name}`, name, kind: "agent" as const });

let seq = 0;
const ev = (actor: SessionEvent["actor"], body: EventBody): SessionEvent => ({ seq: ++seq, ts: 1_000 + seq, actor, body });
const run = (id: string, command: string) => ({ id, name: "run_command", arguments: JSON.stringify({ command }) });

function session(extra: SessionEvent[] = []): SessionEvent[] {
  seq = 0;
  return [
    ev(human("Priya"), { type: "session.created", title: "Dark mode", ownerId: "Priya", ownerName: "Priya", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody),
    ev(human("Priya"), { type: "instruction", text: "Move the settings screen onto the theme tokens.", interrupt: false }),
    ev(human("Noah"), { type: "instruction", text: "And keep the danger row readable.", interrupt: false }),
    ev(agent("Friday Code"), { type: "agent.message", text: "", toolCalls: [run("t1", "npm test")] }),
    ev(agent("Friday Code"), { type: "tool.result", callId: "t1", name: "run_command", output: "$ npm test\n(exited 0)\nok", isError: false }),
    ...extra,
  ];
}

test("the description says why, what was decided, who steered and whether it was checked", () => {
  const events = session([
    ev(agent("Friday Code"), { type: "memory.saved", key: "token-source", text: "Colours come from theme.ts, never a literal." }),
    ev(agent("Friday Code"), { type: "agent.message", text: "Done.", toolCalls: [] }),
  ]);
  const body = prBodyFor(project("s", events), events, "https://friday.test/?session=s");
  assert.match(body, /## Why\nMove the settings screen onto the theme tokens\./, "the goal is the first thing asked");
  assert.match(body, /\*\*token-source\*\*: Colours come from theme\.ts/);
  assert.match(body, /Priya \(1 instruction\) and Noah \(1 instruction\), worked by Friday Code\./);
  assert.match(body, /## Verified by Friday\n\*\*Tests passed\*\* \(`npm test`\)/);
  assert.match(body, /1 command ran/);
  assert.match(body, /Opened from a Friday session: https:\/\/friday\.test\/\?session=s/);
});

test("a later note under the same key replaces the earlier one", () => {
  const events = session([
    ev(agent("Friday Code"), { type: "memory.saved", key: "approach", text: "Use inline styles." }),
    ev(human("Priya"), { type: "memory.saved", key: "approach", text: "Use tokens, not inline styles." }),
  ]);
  const body = prBodyFor(project("s", events), events);
  assert.match(body, /Use tokens, not inline styles\./);
  assert.ok(!/Use inline styles\./.test(body), "the correction stands alone");
});

test("what was never checked is not dressed up: no tests is said, and a section with nothing behind it is left out", () => {
  seq = 0;
  const events = [
    ev(human("Priya"), { type: "session.created", title: "t", ownerId: "Priya", ownerName: "Priya", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody),
    ev(human("Priya"), { type: "instruction", text: "Tidy it.", interrupt: false }),
  ];
  const body = prBodyFor(project("s", events), events);
  assert.match(body, /\*\*Tests not run\*\*/);
  assert.ok(!/## Decisions/.test(body), "no decisions were written down, so there is no such section");
  assert.ok(!/Opened from a Friday session/.test(body), "and no link when there is nowhere to link to");
});

test("committing with a pull request hands the session's account to the publish call, and a plain push does not", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const published: string[] = [];
  const folder = async (_sid: string, req: { op: string; message?: string }) => {
    if (req.op === "commit") return { output: JSON.stringify({ sha: "a".repeat(40), branch: "feature/x", files: 1 }) };
    if (req.op === "publish") {
      published.push(req.message ?? "");
      return { output: JSON.stringify({ pushed: true, prUrl: "https://github.com/o/r/pull/1", prCreated: true }) };
    }
    return { output: "" };
  };
  const core = new SessionCore(store, () => {}, undefined, undefined, undefined, folder as never, "https://friday.test");
  await store.create("s1", "Dark mode", { ...ada, role: "owner" }, {}, "w");
  assert.equal((await core.handle("s1", ada, { type: "instruct", text: "Move settings onto tokens." })).ok, true);

  const r = await core.handle("s1", ada, { type: "folder.commit", message: "Use theme tokens\n\nMoves Screen.tsx.", push: true, pr: true });
  assert.equal(r.ok, true);
  const sent = published[0]!;
  assert.match(sent, /^Use theme tokens\n\nMoves Screen\.tsx\.\n\n## Why\nMove settings onto tokens\./, "the commit message first, then the why");
  assert.match(sent, /https:\/\/friday\.test\/\?session=s1/);

  published.length = 0;
  await core.handle("s1", ada, { type: "folder.commit", message: "Second commit", push: true });
  assert.equal(published[0], "Second commit", "a push with no PR sends the message untouched");
});

test("the description carries what changed, the plan, how review went, and what is not done", () => {
  const ev = (seq: number, body: EventBody, who = "Ada", kind: "human" | "agent" = "human"): SessionEvent => ({ seq, ts: seq, actor: { id: who.toLowerCase(), name: who, kind } as SessionEvent["actor"], body });
  const events: SessionEvent[] = [
    ev(1, { type: "session.created", title: "t", ownerId: "ada", ownerName: "Ada" }, "System"),
    ev(2, { type: "instruction", text: "Use the pool everywhere", interrupt: false }),
    ev(3, { type: "agent.diff", base: "x", files: [{ path: "src/db.ts", status: "modified", additions: 12, deletions: 3, patch: "" }] } as EventBody, "Friday", "agent"),
    ev(4, { type: "plan.reviewed", verdict: "approve" }, "Bo"),
    ev(5, { type: "plan.approved", steps: ["Add the pool", "Use it in db.ts"] }),
    ev(6, { type: "thread.opened", id: "a", path: "src/db.ts", line: 4, code: "x", text: "Close the client", removed: false } as EventBody, "Bo"),
    ev(7, { type: "thread.resolved", id: "a", auto: { lane: "main" } }, "System"),
    ev(8, { type: "thread.opened", id: "b", path: "src/db.ts", line: 40, code: "y", text: "Handle the timeout", removed: false } as EventBody, "Bo"),
    ev(9, { type: "folder.ran", command: "npm test", output: "1 failed", isError: true }),
  ];
  const body = prBodyFor(project("s", events), events);
  assert.match(body, /## What changed\n- `src\/db\.ts` \(\+12 −3\)/);
  assert.match(body, /## Plan\nApproved by Ada with changes\.\n1\. Add the pool\n2\. Use it in db\.ts/);
  assert.match(body, /- Signed off on the plan: Bo/);
  assert.match(body, /- 2 review comments, 1 resolved \(1 closed by the agent's own change\)/);
  assert.match(body, /“Close the client” — fixed/);
  assert.match(body, /## Not done\n- Open comment on `src\/db\.ts:40`: “Handle the timeout”\n- `npm test` last failed/);
  assert.ok(body.indexOf("## Why") < body.indexOf("## What changed") && body.indexOf("## What changed") < body.indexOf("## Verified by Friday"));
});

test("with no plan, no review and nothing open, those sections are not there", () => {
  const events: SessionEvent[] = [{ seq: 1, ts: 1, actor: { id: "ada", name: "Ada", kind: "human" } as SessionEvent["actor"], body: { type: "instruction", text: "Do it", interrupt: false } }];
  const body = prBodyFor(project("s", events), events);
  for (const h of ["## What changed", "## Plan", "## Review", "## Not done"]) assert.ok(!body.includes(h), h);
});

test("a commit subject with no model to write one: the person's own ask when it reads as one, else the files", () => {
  const files = [{ path: "README.md" }];
  assert.equal(plainCommitMessage(files, "add a line to the README saying how to run the tests"), "Add a line to the README saying how to run the tests");
  assert.equal(plainCommitMessage(files, "Please fix the login redirect."), "Fix the login redirect");
  assert.equal(plainCommitMessage(files, "why is this failing?"), "Update README.md", "a question is not a subject");
  assert.equal(plainCommitMessage([{ path: "a" }, { path: "b" }], "hi"), "Update 2 files", "nor a greeting");
  assert.equal(plainCommitMessage(files, "Fix it\n\nAnd then explain what you did, in detail"), "Update README.md", "nor an essay");
  assert.equal(plainCommitMessage(files, "x".repeat(80)), "Update README.md", "nor a line too long for one");
});

test("the description keeps the person's own words, hides a command's environment, and can't break out of its code marks", () => {
  const events = session([
    ev(agent("Friday Code"), { type: "agent.message", text: "", toolCalls: [run("t9", "API_KEY=sk-secret npm test")] }),
    ev(agent("Friday Code"), { type: "tool.result", callId: "t9", name: "run_command", output: "$ API_KEY=sk-secret npm test\n(exited 0)\nok", isError: false }),
    ev(agent("Friday Code"), { type: "agent.diff", base: "x", files: [{ path: "src/a`b.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" }] } as EventBody),
  ]);
  // A session started from an issue carries the issue's text after a rule: only what the person wrote is the why.
  events[1]!.body = { type: "instruction", text: 'Fix the redirect loop.\n\n---\n\nGitHub issue #12: https://github.com/o/r/issues/12\n\n<untrusted source="GitHub issue #12">\nLogin loops\n</untrusted>\n\nText inside <untrusted> tags was written outside this session.', interrupt: false };
  const body = prBodyFor(project("s", events), events);
  assert.match(body, /## Why\nFix the redirect loop\.\n/);
  assert.doesNotMatch(body, /untrusted|GitHub issue #12|Login loops/);
  assert.match(body, /API_KEY=… npm test/, "the value is not in a public description");
  assert.doesNotMatch(body, /sk-secret/);
  assert.match(body, /`src\/a'b\.ts`/, "a backtick in a path can't end the code mark early");
});

test("the description names one owner, says who allowed or refused each command an agent asked for, and what was undone", () => {
  const events = session([
    ev(human("Priya"), { type: "control.granted", to: "Noah", toName: "Noah", reason: "handoff" }),
    ev(agent("Claude Code"), { type: "engine.approval", id: "a1", scope: "commands", items: ["npm install express-rate-limit@7"] }),
    ev(human("Noah"), { type: "instruction", text: "Yes, run it.", interrupt: false, approval: { id: "a1", approve: true } }),
    ev(agent("Claude Code"), { type: "engine.approval", id: "a2", scope: "commands", items: ["rm -rf dist"] }),
    ev(human("Noah"), { type: "instruction", text: "No.", interrupt: false, approval: { id: "a2", approve: false } }),
    ev(agent("Claude Code"), { type: "engine.approval", id: "a3", scope: "commands", items: ["git push --force"] }),
    ev(human("Noah"), { type: "folder.restored", sha: "a".repeat(40), undo: "b".repeat(40), restored: 2, removed: 0 }),
  ]);
  const body = prBodyFor(project("s", events), events);
  assert.match(body, /## Owner\n\*\*Noah\*\* is accountable for this change/, "the driver when it was opened, after the hand-over");
  assert.match(body, /`npm install express-rate-limit@7`: allowed by Noah/);
  assert.match(body, /`rm -rf dist`: refused by Noah/);
  assert.match(body, /`git push --force`: asked, never answered/);
  assert.match(body, /## Tried and undone\nThe work was rewound 1 time/);
});

test("the recording link goes into a pull request for a private repository, and for a public one only when the owner says so (Security APP-3)", async (t) => {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const prefix = `mpatest:${Math.random().toString(36).slice(2, 10)}:`;
  t.after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const store = new SessionStore(redis, prefix);
  const published: string[] = [];
  const folder = async (_sid: string, req: { op: string; message?: string }) => {
    if (req.op === "remote") return { output: JSON.stringify({ url: "https://github.com/o/r.git", github: "o/r", branch: "feature/x" }) };
    if (req.op === "commit") return { output: JSON.stringify({ sha: "a".repeat(40), branch: "feature/x", files: 1 }) };
    if (req.op === "publish") {
      published.push(req.message ?? "");
      return { output: JSON.stringify({ pushed: true, prUrl: "https://github.com/o/r/pull/1", prCreated: true }) };
    }
    return { output: "" };
  };
  const replay = () => "https://friday.test/?replay=s1&t=tok";
  const core = new SessionCore(store, () => {}, undefined, undefined, undefined, folder as never, "https://friday.test", undefined, replay);
  await store.create("s1", "Dark mode", { ...ada, role: "owner" }, {}, "w");
  assert.equal((await core.handle("s1", ada, { type: "instruct", text: "Move settings onto tokens." })).ok, true);
  const opened = async (visibility: "public" | "private" | null) => {
    core.repoVisibility = async (slug) => (assert.equal(slug, "o/r"), visibility);
    published.length = 0;
    assert.equal((await core.handle("s1", ada, { type: "folder.commit", message: "A change", push: true, pr: true })).ok, true);
    return published[0]!;
  };
  assert.doesNotMatch(await opened("public"), /\?replay=/, "a public repository's readers are everyone");
  assert.doesNotMatch(await opened(null), /\?replay=/, "a repository whose visibility can't be told counts as public");
  assert.match(await opened("private"), /\?replay=s1/, "a private repository's pull request links the recording");
  assert.equal((await core.handle("s1", ada, { type: "settings.update", prReplay: true })).ok, true);
  assert.match(await opened("public"), /\?replay=s1/, "the owner turned it on for this session");
  const ben = { id: "u-ben", name: "Ben" };
  await store.ensureMember("s1", { ...ben, role: "editor" }, await store.state("s1"));
  assert.equal((await core.handle("s1", ben, { type: "settings.update", prReplay: false })).ok, false, "only the owner decides");
});
