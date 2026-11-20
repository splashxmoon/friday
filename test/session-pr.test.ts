// The session's pull request (session/projection.ts sessionPr and state.pr): the newest it opened, whether Friday's commit opened it
// or an agent did with its own `gh pr create` (Arun, 2026-11-20: "i opened a pull request but it is stuck at the merged thing").
import assert from "node:assert/strict";
import test from "node:test";
import { project, sessionPr, sessionPrs } from "../src/session/projection.js";
import type { SessionEvent } from "../src/types.js";

const A = "https://github.com/acme/app/pull/1";
const B = "https://github.com/acme/app/pull/2";
let seq = 0;
const ev = (body: Record<string, unknown>, lane?: string): SessionEvent => ({ seq: ++seq, ts: 1000 + seq, actor: { kind: "human", id: "u1", name: "Ada" }, ...(lane ? { lane } : {}), body }) as unknown as SessionEvent;

test("a pull request an agent opened after one Friday's commit opened is the session's from then on", () => {
  const events = [
    ev({ type: "folder.committed", sha: "a".repeat(40), branch: "friday/one", base: "main", message: "One", files: 2, pushed: true, prUrl: A, prCreated: true }),
    ev({ type: "pr.shepherd", on: true, prUrl: A }),
    ev({ type: "pr.shepherd.ended", outcome: "merged" }),
    ev({ type: "tool.result", callId: "c1", name: "Bash", output: `Creating pull request for friday/two into main\n\n${B}\n`, isError: false }, "w2"),
  ];
  assert.deepEqual(sessionPr(events), { url: B, lane: "w2", ts: events[3]!.ts, seq: events[3]!.seq });
  assert.equal(sessionPr(events, A)?.url, A, "the earlier one, picked from the list");
  assert.equal(sessionPr(events, "https://github.com/acme/other/pull/9"), null, "never one the session didn't open");
  assert.deepEqual(sessionPrs(events).map((p) => p.url), [B, A], "every one, newest first");
  const s = project("s", events);
  assert.deepEqual(s.pr, { url: A, merged: true }, "state.pr stays the one Friday opened");
  assert.deepEqual(s.prs, [A, B]);
});

test("a commit is still its pull request when no agent opened another; a failed command or a link in passing opens none", () => {
  const commit = ev({ type: "folder.committed", sha: "b".repeat(40), branch: "friday/one", base: "main", message: "One", files: 1, pushed: true, prUrl: A, prCreated: true });
  const failed = ev({ type: "tool.result", callId: "c2", name: "Bash", output: B, isError: true });
  const mention = ev({ type: "tool.result", callId: "c3", name: "Bash", output: `See ${B} for the earlier one.\nDone.`, isError: false });
  assert.equal(sessionPr([commit, failed, mention])?.url, A);
  assert.equal(sessionPr([]), null);
});
