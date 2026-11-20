import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { reachForMessage } from "../src/client/smartReach.js";
import { OPEN_PR_ASK, parseReview, readReview, reviewCounts, SELF_REVIEW_ASK, TICKET_REVIEW_STEP } from "../src/client/self-review.js";

const require = createRequire(import.meta.url);

test("a review report is read, with bad parts made safe", () => {
  const f = parseReview(JSON.stringify([
    { title: "Missing Retry-After waited 0 ms", severity: "bug", status: "fixed", detail: "falls back", file: "retry.ts", line: 8 },
    { title: "Needs LEDGER-88", severity: "weird", status: "later", detail: 5, file: null, line: -2 },
    { title: "" },
    "x",
  ]))!;
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { title: "Missing Retry-After waited 0 ms", severity: "bug", status: "fixed", detail: "falls back", file: "retry.ts", line: 8 });
  assert.deepEqual([f[1]!.severity, f[1]!.status, f[1]!.detail, f[1]!.file, f[1]!.line], ["style", "open", "", "", 0]);
  assert.equal(parseReview("not json"), null);
  assert.equal(parseReview("{}"), null);
  assert.deepEqual(parseReview("[]"), []);
});

test("the header counts files and findings", () => {
  const mk = (file: string) => ({ title: "t", severity: "bug" as const, status: "fixed" as const, detail: "", file, line: 1 });
  assert.equal(reviewCounts([mk("a.ts"), mk("a.ts"), mk("b.ts"), mk("")]), "2 files · 4 findings");
  assert.equal(reviewCounts([mk("a.ts")]), "1 file · 1 finding");
  assert.equal(reviewCounts([]), "no findings");
  // The agent's own count of files it went over wins, so a clean review of 3 files says so.
  assert.equal(reviewCounts([], 3), "3 files · no findings");
  assert.deepEqual(readReview(JSON.stringify({ files: 3, findings: [] })), { findings: [], files: 3 });
  assert.equal(readReview(JSON.stringify({ files: "x", findings: [{ title: "a" }] }))!.files, 0);
  assert.equal(readReview(JSON.stringify({ files: 2 })), null);
});

test("the self-review ask runs where the agent can edit, never in Plan", () => {
  // "Review your…" read as a reading job, and the agent was put in Plan with nothing to fix with (review, 2026-11-19).
  const r = reachForMessage(SELF_REVIEW_ASK);
  assert.ok(r && r.mode !== "plan", JSON.stringify(r));
});

test("the asks name the fence and the pull request", () => {
  assert.match(SELF_REVIEW_ASK, /friday-review/);
  assert.match(SELF_REVIEW_ASK, /git diff/);
  assert.match(TICKET_REVIEW_STEP, /friday-review/);
  assert.match(OPEN_PR_ASK, /Open the pull request now/);
  assert.doesNotMatch(SELF_REVIEW_ASK + TICKET_REVIEW_STEP, /VS Code/);
});

test("the IDE makes threads only for findings with a file, relative ones from the folder", () => {
  const { reviewThreads, watchReview } = require("../src/vscode-ext/friday/review.js");
  const root = path.join(path.sep, "w", "app");
  const t = reviewThreads(
    [
      { title: "A", severity: "bug", status: "fixed", detail: "d", file: "src/a.ts", line: 8 },
      { title: "B", severity: "for-you", status: "open", detail: "", file: "", line: 0 },
      { title: "C", severity: "test", status: "open", detail: "", file: path.join(root, "c.ts"), line: 0 },
    ],
    root,
  );
  assert.equal(t.length, 2);
  assert.equal(t[0].file, path.join(root, "src", "a.ts"));
  assert.equal(t[0].label, "Bug · fixed");
  assert.equal(t[1].line, 1);
  assert.equal(t[1].label, "Test · open");
  // Without the comments API (an older IDE, a test's stand-in) it quietly does nothing.
  process.env.FRIDAY_URL = "http://127.0.0.1:1";
  process.env.FRIDAY_VSCODE_TOKEN = "x";
  const subs: unknown[] = [];
  watchReview({ subscriptions: subs }, {});
  assert.equal(subs.length, 0);
});

test("the IDE draws each finding as a read-only thread, and replaces them when a newer review comes", async () => {
  const { watchReview } = require("../src/vscode-ext/friday/review.js");
  const made: { file: string; line: number; canReply?: boolean; disposed?: boolean; collapsibleState?: number; comments: { body: string; label: string }[] }[] = [];
  const vscode = {
    comments: { createCommentController: () => ({ createCommentThread: (uri: { fsPath: string }, range: { line: number }, comments: never[]) => { const t = { file: uri.fsPath, line: range.line + 1, comments, dispose() { t.disposed = true; } } as (typeof made)[number] & { dispose(): void }; made.push(t); return t; }, dispose() {} }) },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    CommentMode: { Preview: 1 },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    Range: class { constructor(public line: number) {} },
  };
  let body = { seq: 1, folder: path.join(path.sep, "w"), findings: [{ title: "Bug A", severity: "bug", status: "open", detail: "why", file: "a.ts", line: 3 }] };
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: { headers: Record<string, string> }) => ((init.headers["x-friday-vscode"] === "tok") ? { ok: true, json: async () => body } : { ok: false })) as never;
  process.env.FRIDAY_URL = "http://x";
  process.env.FRIDAY_VSCODE_TOKEN = "tok";
  const subs: { dispose(): void }[] = [];
  try {
    watchReview({ subscriptions: subs }, vscode);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(made.length, 1);
    assert.equal(made[0]!.file, path.join(path.sep, "w", "a.ts"));
    assert.equal(made[0]!.line, 3);
    assert.equal(made[0]!.canReply, false);
    assert.equal(made[0]!.collapsibleState, 1);
    // The title heads the thread and the body is what the finding says: neither repeated.
    assert.equal((made[0] as { label?: string }).label, "Bug A");
    assert.equal(made[0]!.comments[0]!.body, "why");
    // Plain text: the agent's words are not Markdown.
    assert.equal(typeof made[0]!.comments[0]!.body, "string");
    assert.equal(made[0]!.comments[0]!.label, "Bug · open");
    // A newer review replaces them: the first thread is disposed and the new one drawn; the same seq draws nothing again.
    body = { seq: 2, folder: path.join(path.sep, "w"), findings: [{ title: "Bug B", severity: "test", status: "fixed", detail: "", file: "b.ts", line: 9 }] };
    await new Promise((r) => setTimeout(r, 4400));
    assert.equal(made[0]!.disposed, true);
    assert.equal(made.length, 2);
    assert.match(made[1]!.comments[0]!.body, /Bug B/);
    assert.equal(made[1]!.collapsibleState, 0);
  } finally {
    for (const s of subs) s.dispose();
    globalThis.fetch = real;
  }
});
