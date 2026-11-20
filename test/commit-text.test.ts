import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chatFor, writeCommitMessage, type Chats } from "../src/commit-ask.js";
import { cleanMessage, commitPrompt, detectStyle, fairDiff, guessType, plainMessage, plainWithWhy, sessionWhy, styleNote, touches } from "../src/commit-text.js";
import { prPartsFor, type PrParts } from "../src/pr-body.js";
import { fillPrTemplate } from "../src/pr-template.js";
import { templatedBody } from "../src/runner/pr-template-read.js";
import { readRepo } from "../src/runner/repo-read.js";
import { project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const require = createRequire(import.meta.url);

const conv = ["feat(auth): add magic-link sign in", "fix(api): stop retrying on 4xx", "docs: explain the env file", "chore(deps): bump vite", "fix: handle empty cart", "refactor(ui): split the header"];
const plainImperative = ["Add a Notes section to the README", "Fix the flaky checkout test", "Remove the old banner", "Update the pricing copy", "Move settings onto theme tokens"];
const past = ["Added retry to the uploader.", "Fixed the date parsing.", "Removed dead code.", "Updated the changelog.", "Renamed the config key."];

test("conventional commits are told from plain ones, with their types and scopes", () => {
  const c = detectStyle(conv);
  assert.equal(c.conventional, true);
  assert.equal(c.scopes, true);
  assert.deepEqual(c.types.slice(0, 2), ["fix", "feat"]);
  assert.equal(c.tense, "imperative");
  assert.equal(c.capital, false, "the sentence after feat: starts lower-case");
  const p = detectStyle(plainImperative);
  assert.equal(p.conventional, false);
  assert.deepEqual(p.types, []);
  assert.equal(p.capital, true);
  assert.equal(p.period, false);
});

test("imperative, past and present tense are told apart", () => {
  assert.equal(detectStyle(plainImperative).tense, "imperative");
  const p = detectStyle(past);
  assert.equal(p.tense, "past");
  assert.equal(p.period, true);
  assert.equal(detectStyle(["Adds a retry", "Fixes the date", "Removes dead code", "Updates the docs"]).tense, "present");
  // Words that only end in "ed" are not past tense.
  assert.equal(detectStyle(["Speed up the build", "Embed the logo", "Need a test for login", "Feed the cache"]).tense, "imperative");
});

test("merges and fixups are not the repo's voice, and few commits say little", () => {
  const s = detectStyle(["Merge pull request #4 from a/b", "Merge branch 'main'", "fixup! Add a thing", "Add a thing"]);
  assert.equal(s.from, 1);
  const none = detectStyle([]);
  assert.equal(none.from, 0);
  assert.equal(none.tense, "imperative");
  assert.match(styleNote(none), /imperative mood, under 65 characters/);
});

test("the subject length, bodies, tickets and emoji follow the history", () => {
  const long = detectStyle(["Add a very long subject line that goes on for quite a while indeed ok", "Add another very long subject line that also goes on for a good while", "Fix a third long subject that is nearly as long as the others are ok"]);
  assert.ok(long.maxSubject >= 66 && long.maxSubject <= 72);
  assert.equal(detectStyle(["Add a", "Fix b", "Drop c"]).maxSubject, 50);
  const body = detectStyle([{ subject: "Add a", body: true }, { subject: "Fix b", body: true }, { subject: "Drop c" }]);
  assert.equal(body.bodies, true);
  assert.equal(detectStyle(["PROJ-12 Add a", "PROJ-13 Fix b", "PROJ-14 Drop c"]).ticket, true);
  assert.equal(detectStyle(["✨ Add a", "🐛 Fix b", ":fire: Drop c"]).emoji, true);
  assert.match(styleNote(detectStyle(conv)), /conventional commits.*feat\(scope\):/);
  assert.match(styleNote(detectStyle(past)), /past tense/);
});

test("with no model, the files and the ask are set in the repo's style", () => {
  const files = [{ path: "README.md" }];
  assert.equal(plainMessage(files, "Add a Notes section to the README", detectStyle(plainImperative)), "Add a Notes section to the README");
  assert.equal(plainMessage(files, "Add a Notes section to the README", detectStyle(conv)), "docs: add a Notes section to the README");
  assert.equal(plainMessage(files, "Add a Notes section to the README", detectStyle(past)), "Added a Notes section to the README.");
  assert.equal(plainMessage([{ path: "a.ts" }, { path: "b.ts" }], "", detectStyle(past)), "Updated 2 files.");
  assert.equal(plainMessage([{ path: "src/a.ts" }], "does the login break? why", detectStyle(conv)), "chore: update src/a.ts");
  assert.equal(guessType([{ path: "src/a.ts" }], "fix the crash on empty input", ["feat", "fix"]), "fix");
  assert.equal(guessType([{ path: "test/a.test.ts" }], "", []), "test");
  // A type the repo doesn't use is not invented.
  assert.equal(guessType([{ path: "README.md" }], "", ["feat", "fix"]), "feat");
});

test("a model's answer is made safe for the box", () => {
  const style = detectStyle(plainImperative);
  assert.equal(cleanMessage("```\nAdd a Notes section.\n\nWhy: so people know.\n```", style), "Add a Notes section\n\nWhy: so people know.");
  assert.equal(cleanMessage('"Fix the thing"', style), "Fix the thing");
  assert.equal(cleanMessage("Here is the commit message:\nFix the thing", style), "Fix the thing");
  assert.equal(cleanMessage("Fix the thing", detectStyle(past)), "Fix the thing.");
  // The commonest bad shape: a preamble, then the message in a fence.
  const c = detectStyle(conv);
  assert.equal(cleanMessage("Here is the commit message:\n\n```\nfeat: add x.\n\nbody\n```", c), "feat: add x\n\nbody");
  assert.equal(cleanMessage("```text\nHere's the message:\nfeat: add x\n```", c), "feat: add x");
  assert.equal(cleanMessage("**feat: add x**\n\nbody", c), "feat: add x\n\nbody");
  assert.equal(cleanMessage("`feat: add x`", c), "feat: add x");
  assert.equal(cleanMessage("# fix: stop it", c), "fix: stop it");
});

test("plain words are right: acronyms stay, a verb is not said twice, past tense doubles its consonant", () => {
  const c = detectStyle(conv);
  assert.equal(plainMessage([{ path: "src/a.ts" }], "API returns 500 on empty input", c), "chore: API returns 500 on empty input");
  assert.equal(plainMessage([{ path: "src/a.ts" }], "Fix the crash on empty input", c), "fix: crash on empty input");
  const p = detectStyle(past);
  for (const [v, w] of [["Stop", "Stopped"], ["Drop", "Dropped"], ["Skip", "Skipped"], ["Log", "Logged"], ["Wrap", "Wrapped"], ["Show", "Showed"], ["Load", "Loaded"]]) {
    assert.equal(plainMessage([{ path: "a.ts" }], `${v} the old retries`, p), `${w} the old retries.`);
  }
});

test("area prefixes outside the conventional types are a prefix style, and the prompt says so", () => {
  const s = detectStyle(["core: fix the parser", "ui: tidy the header", "core: drop the old cache", "docs: explain it"]);
  assert.equal(s.conventional, false);
  assert.equal(s.prefixed, true);
  assert.deepEqual(s.prefixes.slice(0, 2), ["core", "ui"]);
  assert.equal(s.capital, false);
  assert.equal(s.tense, "imperative");
  assert.match(styleNote(s), /area prefix, like core: ui:/);
  assert.doesNotMatch(styleNote(s), /does not use/);
  assert.equal(plainMessage([{ path: "core/a.ts" }], "Fix the parser bug", s), "core: fix the parser bug");
  assert.equal(detectStyle(plainImperative).prefixed, false);
});

test("a diff is cut fairly: every file keeps a share", () => {
  const big = "diff --git a/big.ts b/big.ts\n" + "+x\n".repeat(5000);
  const small = "diff --git a/small.ts b/small.ts\n+tiny\n";
  const cut = fairDiff(big + small, 3000);
  assert.ok(cut.length <= 3200);
  assert.match(cut, /small\.ts[\s\S]*\+tiny/);
  assert.match(cut, /cut\)/);
  assert.equal(fairDiff(small, 3000), small);
});

const ada = { id: "u", name: "Ada", kind: "human" as const };
const bot = { id: "e", name: "Claude Code", kind: "agent" as const };
let seq = 0;
const ev = (actor: SessionEvent["actor"], body: EventBody): SessionEvent => ({ seq: ++seq, ts: 1000 + seq, actor, body });
function chat(extra: SessionEvent[] = []) {
  seq = 0;
  const events = [
    ev(ada, { type: "session.created", title: "Notes", ownerId: "u", ownerName: "Ada", workspaceId: "w", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } } as EventBody),
    ev(ada, { type: "instruction", text: "Add a Notes section to the README so people know how to run the tests", interrupt: false }),
    ev(bot, { type: "memory.saved", key: "where", text: "Notes goes under Usage, not at the end." }),
    ev(bot, { type: "agent.diff", lane: "main", files: [{ path: "README.md", status: "modified", additions: 4, deletions: 0, patch: "" }] } as unknown as EventBody),
    ev(bot, { type: "agent.message", text: "Done: I added a Notes section to README.md", toolCalls: [] }),
    ...extra,
  ];
  return { events, state: project("s", events) };
}

test("the why is the ask since the last commit, the decisions and the agent's closing words", () => {
  const { events, state } = chat();
  const why = sessionWhy(state, events)!;
  assert.match(why.asked, /^Add a Notes section to the README/);
  assert.deepEqual(why.decisions, ["where: Notes goes under Usage, not at the end."]);
  assert.match(why.did, /^Done: I added a Notes section/);
  assert.equal(sessionWhy(null, []), null);
  // A commit in between: the next commit is not named for the first task.
  const again = chat([ev(bot, { type: "folder.committed", sha: "a".repeat(40), branch: "main", message: "x", files: 1 } as EventBody), ev(ada, { type: "instruction", text: "Now fix the typo in the header", interrupt: false })]);
  assert.match(sessionWhy(again.state, again.events)!.asked, /^Now fix the typo/);
});

test("the prompt carries the style, the why, the files and the diff", () => {
  const { events, state } = chat();
  const p = commitPrompt({ style: detectStyle(conv), subjects: conv, files: [{ path: "README.md", status: "modified" }], diff: "diff --git a/README.md b/README.md\n+## Notes\n", why: sessionWhy(state, events), staged: true });
  assert.match(p, /staged changes/);
  assert.match(p, /conventional commits/);
  assert.match(p, /- feat\(auth\): add magic-link sign in/);
  assert.match(p, /They asked an agent: Add a Notes section/);
  assert.match(p, /Notes goes under Usage/);
  assert.match(p, /- modified README\.md/);
  assert.match(p, /\+## Notes/);
});

test("changed paths are matched to a chat's own files, however each is spelled", () => {
  assert.equal(touches(["README.md"], ["README.md"]), true);
  assert.equal(touches(["src\\a.ts"], ["src/a.ts"]), true);
  assert.equal(touches(["a.ts"], ["pkg/a.ts"]), false, "index.ts at one root is not packages/other/src/index.ts");
  assert.equal(touches(["a.ts"], ["pkg/a.ts"], "pkg"), true, "a chat opened on pkg/ names its files from there");
  assert.equal(touches(["a.ts"], ["b.ts"]), false);
});

test("a Code chat that made these changes gives the why; one that did not is left out", async () => {
  const { events, state } = chat();
  const chats: Chats = { list: () => [{ sid: "s", title: "Notes", folder: "/work/app/", tool: "codex", at: 5 }], state: async () => state, events: async () => events };
  const hit = await chatFor(chats, "/work/app", [{ path: "README.md" }]);
  assert.equal(hit?.title, "Notes");
  assert.equal(hit?.tool, "codex");
  assert.equal(await chatFor(chats, "/work/app", [{ path: "other.ts" }]), null);
  assert.equal(await chatFor(chats, "/elsewhere", [{ path: "README.md" }]), null);
  // A workspace opened on a folder inside the repo still gives its why.
  const inner: Chats = { ...chats, list: () => [{ sid: "s", title: "Inner", folder: "/work/app/docs", tool: "claude", at: 5 }] };
  assert.equal((await chatFor(inner, "/work/app", [{ path: "docs/README.md" }]))?.title, "Inner");
  assert.equal(await chatFor(inner, "/work/app", [{ path: "README.md" }]), null);
  assert.equal(await chatFor(inner, "/work/app2", [{ path: "docs/README.md" }]), null);
});

test("writing the message: the person's tool when one answers, else a plain summary in the style", async () => {
  const { events, state } = chat();
  const chats: Chats = { list: () => [{ sid: "s", title: "Notes", folder: "/w", tool: "claude", at: 1 }], state: async () => state, events: async () => events };
  const input = { root: "/w", diff: "diff --git a/README.md b/README.md\n+x\n", files: [{ path: "README.md", status: "modified" }], log: conv.map((subject) => ({ subject })), staged: true };
  const asked: Record<string, unknown>[] = [];
  const host = (tools: unknown[], answer: string) => async (method: string, params: Record<string, unknown>) => {
    if (method === "tools") return { tools };
    asked.push(params);
    return { text: answer };
  };
  const ok = await writeCommitMessage(host([{ tool: "codex", path: "/x", loggedIn: true }, { tool: "claude", path: "/y", loggedIn: true, name: "Claude Code" }], "docs: add a Notes section\n\nSo people can run the tests."), chats, input);
  assert.equal(ok.source, "tool");
  assert.equal(ok.tool, "Claude Code");
  assert.equal(ok.chat, "Notes");
  assert.match(ok.message, /^docs: add a Notes section/);
  assert.equal(asked[0]!.tool, "claude", "the tool the chat used goes first");
  assert.match(String(asked[0]!.prompt), /Add a Notes section to the README/);
  const none = await writeCommitMessage(host([{ tool: "claude", path: null, loggedIn: null }, { tool: "codex", path: "/x", loggedIn: false }], ""), chats, input);
  assert.equal(none.source, "plain");
  assert.match(none.message, /^docs: add a Notes section to the README so people know how to run the tests$/);
  assert.match(none.note ?? "", /signed in/);
  const broke = await writeCommitMessage(async (m) => { if (m === "tools") return { tools: [{ tool: "claude", path: "/y", loggedIn: true }] }; throw new Error("out of usage"); }, chats, input);
  assert.equal(broke.source, "plain");
  // The cut is fair in the real path: a big first file leaves the last file's diff in the prompt, and the model is told it was cut.
  asked.length = 0;
  const bigDiff = "diff --git a/big.ts b/big.ts\n" + "+x\n".repeat(40_000) + "diff --git a/last.ts b/last.ts\n+LAST_FILE_LINE\n";
  await writeCommitMessage(host([{ tool: "claude", path: "/y", loggedIn: true }], "fix: it"), chats, { ...input, diff: bigDiff, files: [{ path: "big.ts" }, { path: "last.ts" }] });
  assert.match(String(asked[0]!.prompt), /diff --git a\/last\.ts[\s\S]*LAST_FILE_LINE/);
  assert.match(String(asked[0]!.prompt), /\(cut short\)/);
  assert.match(String(asked[0]!.prompt), /rest of this file's diff cut/);
  // A tool killed at its limit, or one that never answers, leaves the plain summary rather than the next tool or a wait.
  let calls = 0;
  const killed = await writeCommitMessage(async (m) => { if (m === "tools") return { tools: [{ tool: "claude", path: "/y", loggedIn: true }, { tool: "codex", path: "/x", loggedIn: true }] }; calls++; throw new Error("claude exited with code null"); }, chats, input);
  assert.equal(killed.source, "plain");
  assert.match(killed.note ?? "", /too long/);
  assert.equal(calls, 1, "the second tool is not tried after a timeout");
  const hung = await writeCommitMessage(async (m) => { if (m === "tools") return { tools: [{ tool: "claude", path: "/y", loggedIn: true }] }; return new Promise<never>(() => {}); }, chats, input, { totalMs: 60 });
  assert.equal(hung.source, "plain");
  assert.match(hung.note ?? "", /too long/);
  const empty = await writeCommitMessage(host([], ""), chats, { ...input, files: [] });
  assert.equal(empty.message, "");
  assert.equal(plainWithWhy([{ path: "a" }], detectStyle([{ subject: "Add a", body: true }, { subject: "Fix b", body: true }, { subject: "Drop c", body: true }]), sessionWhy(state, events)).split("\n").length > 1, true);
});

// ---- pull-request templates

const parts = (extra: Partial<PrParts> = {}): PrParts => ({ why: "Closes https://github.com/o/r/issues/4\n\nAdd a Notes section to the README.", did: "I added a Notes section to README.md.", changes: ["`README.md` (+4 −0)"], decisions: ["**where**: under Usage"], tests: "pass", testCmd: "npm test", addedTests: false, notDone: [], ...extra });
const TEMPLATE = `<!-- Thanks for the PR! Fill this in. -->
## Summary
<!-- what does it do -->

## Motivation
Why is this needed?

## Changes
-

## How was this tested?
Describe.

## Screenshots
N/A

## Checklist
- [ ] I ran the tests
- [ ] I added tests for this change
- [ ] I updated the docs
`;

test("a template keeps its headings and order, and gets what the session knows", () => {
  const out = fillPrTemplate(TEMPLATE, parts(), "FULL ACCOUNT");
  const heads = [...out.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, ["Summary", "Motivation", "Changes", "How was this tested?", "Screenshots", "Checklist"]);
  assert.ok(!out.includes("<!--"), "its comments are removed");
  assert.match(out, /## Summary\n\nI added a Notes section to README\.md\./);
  assert.match(out, /## Motivation\n\nAdd a Notes section to the README\./);
  assert.match(out, /## Changes\n\n- `README\.md` \(\+4 −0\)/);
  assert.match(out, /## How was this tested\?\n\nThe tests passed \(`npm test`\), run by the agent in this session\./);
  assert.match(out, /## Screenshots\n\nN\/A/, "a section the session knows nothing about keeps the template's text");
  assert.match(out, /<details>\n<summary>The session behind this change<\/summary>\n\nFULL ACCOUNT\n\n<\/details>$/);
});

test("a box is ticked only when the session can vouch for it", () => {
  const passed = fillPrTemplate(TEMPLATE, parts(), "");
  assert.match(passed, /- \[x\] I ran the tests/);
  assert.match(passed, /- \[ \] I added tests for this change/, "no test file changed");
  assert.match(passed, /- \[ \] I updated the docs/);
  const added = fillPrTemplate(TEMPLATE, parts({ addedTests: true }), "");
  assert.match(added, /- \[x\] I added tests for this change/);
  const failed = fillPrTemplate(TEMPLATE, parts({ tests: "fail" }), "");
  assert.match(failed, /- \[ \] I ran the tests/);
  assert.match(failed, /The tests failed/);
  const unrun = fillPrTemplate(TEMPLATE, parts({ tests: "none", testCmd: "" }), "");
  assert.match(unrun, /## How was this tested\?\n\nDescribe\./);
  assert.match(unrun, /- \[ \] I ran the tests/);
});

test("a box is not ticked for what the session cannot vouch for", () => {
  const tpl = ["- [ ] No tests are needed for this change", "- [ ] Unit tests", "- [ ] Integration tests", "- [ ] Tests pass on Windows", "- [ ] Tests pass in CI", "- [ ] All tests pass", "- [ ] Tests were run", "- [ ] I added tests", "- [ ] Manual testing done"].join("\n");
  const out = fillPrTemplate(`## Checklist\n${tpl}\n`, parts({ tests: "pass", addedTests: false }), "");
  assert.deepEqual(out.split("\n").filter((l) => l.includes("[x]")).map((l) => l.slice(6)), ["All tests pass", "Tests were run"]);
  const added = fillPrTemplate(`## Checklist\n${tpl}\n`, parts({ tests: "pass", addedTests: true }), "");
  assert.ok(added.includes("[x] I added tests"));
  assert.ok(added.includes("[ ] No tests are needed"));
  assert.ok(!fillPrTemplate(`## Checklist\n${tpl}\n`, parts({ tests: "fail" }), "").includes("[x]"));
});

test("each kind of section is filled once, and an issue section only ever gets the issue", () => {
  const out = fillPrTemplate("## Motivation\n\n## Additional context\nAnything else?\n\n## Related issues\nFixes #\n\n## Release notes\nNONE\n", parts(), "");
  assert.match(out, /## Motivation\n\nAdd a Notes section to the README\./);
  assert.match(out, /## Additional context\n\nAnything else\?/, "the second why keeps the template's words");
  assert.equal(out.split("Add a Notes section to the README.").length, 2, "the ask appears once");
  assert.match(out, /## Related issues\n\nCloses https:\/\/github\.com\/o\/r\/issues\/4/);
  assert.match(out, /## Release notes\n\nNONE/);
  const none = fillPrTemplate("## Related issues\nFixes #\n", parts({ why: "Add a Notes section." }), "");
  assert.match(none, /## Related issues\n\nFixes #/, "no issue: the prompt stays");
});

test("a template with no headings gets the why on top; decisions and what is not done fill their own section", () => {
  assert.match(fillPrTemplate("Describe your change.\n", parts(), ""), /^Closes https:\/\/github\.com\/o\/r\/issues\/4[\s\S]*Describe your change\.$/);
  const out = fillPrTemplate("## Notes for reviewers\n\n## Why\n", parts({ notDone: ["`npm run lint` last failed"] }), "");
  assert.match(out, /## Notes for reviewers\n\n- \*\*where\*\*: under Usage\n\nNot done:\n- `npm run lint` last failed/);
  assert.match(out, /## Why\n\nAdd a Notes section/);
  // A heading inside a code fence is not a section.
  assert.equal([...fillPrTemplate("## Screenshots\n\n```\n## not a heading\n```\n", parts(), "").matchAll(/^## /gm)].length, 2);
});

test("the session's parts are read as the pull request body reads it", () => {
  const { events, state } = chat([ev(bot, { type: "agent.message", text: "", toolCalls: [{ id: "t", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) }] }), ev(bot, { type: "tool.result", callId: "t", name: "run_command", output: "$ npm test\n(exited 0)\nok", isError: false }), ev(bot, { type: "agent.message", text: "All green.", toolCalls: [] })]);
  const p = prPartsFor(state, events);
  assert.match(p.why, /^Add a Notes section/);
  assert.deepEqual(p.changes, ["`README.md` (+4 −0)"]);
  assert.equal(p.tests, "pass");
  assert.equal(p.testCmd, "npm test");
  assert.equal(p.did, "All green.");
});

test("the runner fills the repo's template when it has one, and leaves the body alone when it has none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-prt-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    assert.equal(await templatedBody(dir, "BODY", JSON.stringify(parts())), "BODY");
    fs.mkdirSync(path.join(dir, ".github"));
    fs.writeFileSync(path.join(dir, ".github", "pull_request_template.md"), "## Why\n");
    const out = await templatedBody(dir, "BODY", JSON.stringify(parts()));
    assert.match(out, /## Why\n\nAdd a Notes section/);
    assert.match(out, /BODY/);
    assert.equal(await templatedBody(dir, "BODY", undefined), "BODY");
    assert.equal(await templatedBody(dir, "BODY", "{not json"), "BODY");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a pull request through the runner puts the filled template in gh's body", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pub-"));
  try {
    const run = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" });
    const origin = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    run(dir, "init", "-q", "--bare", origin);
    run(repo, "init", "-q", "-b", "main");
    fs.mkdirSync(path.join(repo, ".github"));
    fs.writeFileSync(path.join(repo, ".github", "pull_request_template.md"), "## Summary\n\n## Checklist\n- [ ] All tests pass\n- [ ] No tests are needed\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", "first");
    run(repo, "remote", "add", "origin", origin);
    run(repo, "push", "-q", "origin", "main");
    run(repo, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
    run(repo, "commit", "-qam", "second");
    // A gh that keeps the body it was given and answers with a pull request address.
    const bin = path.join(dir, "bin");
    const kept = path.join(dir, "body.md");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--body-file" ]; then cp "$2" "${kept}"; fi; shift; done\necho https://github.com/o/r/pull/9\n`, { mode: 0o755 });
    const was = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${was}`;
    try {
      const answer = JSON.parse(await readRepo(repo, { op: "publish", mode: "full", approved: true, pr: true, message: "Add it\n\nFULL ACCOUNT", prParts: JSON.stringify(parts()) })) as { prUrl?: string; error?: string };
      assert.equal(answer.error, undefined);
      assert.equal(answer.prUrl, "https://github.com/o/r/pull/9");
    } finally {
      process.env.PATH = was;
    }
    const body = fs.readFileSync(kept, "utf8");
    assert.match(body, /## Summary\n\nI added a Notes section to README\.md\./);
    assert.match(body, /- \[x\] All tests pass/);
    assert.match(body, /- \[ \] No tests are needed/);
    assert.match(body, /FULL ACCOUNT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the extension's reading of git

test("the extension reads the staged diff, the files and the last commits from git itself", async () => {
  const ext = require("../src/vscode-ext/friday/commitmsg.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cm-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  try {
    g("init", "-q");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    g("add", "."); g("commit", "-q", "-m", "feat: first\n\nwith a body");
    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    g("add", "."); g("commit", "-q", "-m", "fix: second");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\nchanged\n");
    fs.writeFileSync(path.join(dir, "c.txt"), "brand new\n");
    // Nothing staged: everything changed, the untracked file too.
    let found = await ext.collect("git", dir);
    assert.equal(found.staged, false);
    assert.deepEqual(found.files.map((f: { path: string }) => f.path).sort(), ["a.txt", "c.txt"]);
    assert.match(found.diff, /\+changed/);
    assert.match(found.diff, /\+brand new/);
    assert.deepEqual(found.log, [{ subject: "fix: second", body: false }, { subject: "feat: first", body: true }]);
    // Something staged: only that.
    g("add", "a.txt");
    found = await ext.collect("git", dir);
    assert.equal(found.staged, true);
    assert.deepEqual(found.files, [{ status: "modified", path: "a.txt" }]);
    assert.ok(!found.diff.includes("brand new"));
    assert.equal(ext.messageAsk(dir, found).root, dir);
    assert.match((await ext.collect("git", os.tmpdir())).error ?? "", /isn't a git repository/);
    // A link to a file outside the repository is not sent, and a huge diff is cut fairly to what the request can carry.
    if (process.platform !== "win32") {
      const secret = path.join(os.tmpdir(), `friday-secret-${process.pid}.txt`);
      fs.writeFileSync(secret, "TOP SECRET\n");
      fs.symlinkSync(secret, path.join(dir, "link.txt"));
      g("reset", "-q");
      found = await ext.collect("git", dir);
      assert.ok(!found.diff.includes("TOP SECRET"));
      fs.rmSync(secret, { force: true });
    }
    const big = "diff --git a/big b/big\n" + "+\"x\"\n".repeat(60000) + "diff --git a/last b/last\n+LAST\n";
    const cut = ext.fairCut(big, 60000);
    assert.ok(cut.length <= 60300);
    assert.match(cut, /diff --git a\/last[\s\S]*\+LAST/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository with no commit yet still has its changes read", async () => {
  const ext = require("../src/vscode-ext/friday/commitmsg.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cm0-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "x.md"), "hello\n");
    const found = await ext.collect("git", dir);
    assert.deepEqual(found.files, [{ status: "added", path: "x.md" }]);
    assert.deepEqual(found.log, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("name-status and log output are parsed", () => {
  const ext = require("../src/vscode-ext/friday/commitmsg.js");
  assert.deepEqual(ext.parseNameStatus("M\0a.ts\0A\0b.ts\0D\0c.ts\0R100\0old.ts\0new.ts\0"), [{ status: "modified", path: "a.ts" }, { status: "added", path: "b.ts" }, { status: "deleted", path: "c.ts" }, { status: "renamed", path: "new.ts" }]);
  assert.deepEqual(ext.parseLog("one\x1f\x1e\ntwo\x1fbody here\n\x1e"), [{ subject: "one", body: false }, { subject: "two", body: true }]);
  assert.match(ext.doneNote({ source: "tool", tool: "Claude Code", chat: "Notes" }), /Written by Claude Code from the chat's reason/);
  assert.match(ext.doneNote({ source: "plain", note: "No coding tool here is signed in." }), /plain summary.*Read it, then Commit/);
});

test("the package puts the action in the commit box, the title and the palette", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "vscode-ext", "friday", "package.json"), "utf8"));
  const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === "friday.writeCommitMessage");
  assert.equal(cmd.title, "✳ Write message");
  assert.ok(!/VS Code/i.test(cmd.title));
  assert.ok(pkg.contributes.menus["scm/inputBox"].some((m: { command: string }) => m.command === "friday.writeCommitMessage"));
  assert.ok(pkg.contributes.menus["scm/title"].some((m: { command: string }) => m.command === "friday.writeCommitMessage"));
});

test("one or two commits are not a voice: the usual habits stand", () => {
  const s = detectStyle(["init", "wip stuff"]);
  assert.equal(s.capital, true);
  assert.equal(s.period, false);
  assert.equal(s.tense, "imperative");
  assert.equal(plainMessage([{ path: "README.md" }], "add a notes section to the README", detectStyle(["init"])), "Add a notes section to the README");
});
