// The pull requests a session opened, for its row's badge (Arun, 2026-11-02: "can we add these kinda of things to the coding
// session like tabs?"): only ones it opened, not ones an agent names or lists.
import assert from "node:assert/strict";
import test from "node:test";
import { prOf } from "../src/attention.js";
import { openedPr, project } from "../src/session/projection.js";
import type { SessionEvent } from "../src/types.js";

const A = "https://github.com/acme/shop/pull/12";
const B = "https://github.com/acme/docs/pull/7";

test("a pull request is one the session opened: gh pr create's link, a GitHub tool's create, never one named or listed", () => {
  assert.equal(openedPr("shell", `Creating pull request for fix into main in acme/shop\n\n${A}\n`, false), A);
  assert.equal(openedPr("shell", `${A}\r\n`, false), A, "Windows line endings");
  assert.equal(openedPr("mcp__github__create_pull_request", JSON.stringify({ number: 7, html_url: B }), false), B);
  assert.equal(openedPr("shell", `#12  Fix total  ${A}\n#13  Docs  ${B}\n`, false), null, "gh pr list names others");
  assert.equal(openedPr("shell", `See ${A} for context`, false), null);
  assert.equal(openedPr("shell", `${A}\n`, true), null, "a failed call opened nothing");
});

test("a session keeps every one it opened, oldest first, once each; the sidebar is sent them all", () => {
  let seq = 0;
  const ev = (body: SessionEvent["body"]): SessionEvent => ({ seq: ++seq, ts: seq, sid: "s", actor: { id: "a", name: "Claude Code", kind: "agent" }, body }) as SessionEvent;
  const state = project("s", [
    ev({ type: "tool.result", callId: "c1", name: "shell", output: `${A}\n`, isError: false }),
    ev({ type: "folder.committed", sha: "abc", branch: "fix", message: "Fix", files: 1, prUrl: A, prCreated: true } as never),
    ev({ type: "tool.result", callId: "c2", name: "mcp__github__create_pull_request", output: `{"html_url":"${B}"}`, isError: false }),
  ]);
  assert.deepEqual(state.prs, [A, B]);
  const pr = prOf(state)!;
  assert.deepEqual(pr.urls, [A, B]);
  assert.equal(pr.url, A, "the one Friday opened stays the session's own");
  assert.equal(prOf(project("t", [])), null);
});
