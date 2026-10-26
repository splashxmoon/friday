import assert from "node:assert/strict";
import test from "node:test";
import { applyPrStatus, boardCards } from "../src/board.js";
import { fromApi, fromGh, fromGithubApi, statusOf, type PrStatus } from "../src/github-status.js";
import { initialState } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const status = (over: Partial<PrStatus> = {}): PrStatus => ({ state: "open", draft: false, review: "none", checks: "none", mergeable: true, source: "github", ...over });

test("gh's own JSON becomes the same small status", () => {
  const s = fromGh({ state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }] });
  assert.deepEqual(s, { state: "open", draft: false, review: "approved", checks: "passing", mergeable: true, source: "gh" });
  assert.equal(fromGh({ state: "OPEN", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS" }] })!.checks, "failing", "a failure beats a check still running");
  assert.equal(fromGh({ state: "OPEN", statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] })!.checks, "pending");
  assert.equal(fromGh({ state: "MERGED" })!.state, "merged");
  assert.equal(fromGh({ state: "OPEN", mergeable: "CONFLICTING" })!.mergeable, false);
  assert.equal(fromGh({ error: "gh isn't installed" }), null, "an error is no answer");
});

test("GitHub's API pieces become the same status, each reviewer's last say counting", () => {
  const reviews = [
    { user: { login: "ann" }, state: "CHANGES_REQUESTED" },
    { user: { login: "ann" }, state: "APPROVED" },
    { user: { login: "bo" }, state: "COMMENTED" },
  ];
  assert.equal(fromApi({ state: "open" }, reviews, []).review, "approved", "an approval after a change request clears it");
  assert.equal(fromApi({ state: "open" }, [...reviews, { user: { login: "cy" }, state: "CHANGES_REQUESTED" }], []).review, "changes_requested");
  assert.equal(fromApi({ state: "closed", merged: true }, [], []).state, "merged");
  assert.equal(fromApi({ state: "open" }, [], [{ status: "completed", conclusion: "success" }]).checks, "passing");
});

test("the API is asked first, and gh answers when it cannot", async () => {
  const calls: string[] = [];
  const api = async () => (calls.push("api"), null);
  const gh = async () => (calls.push("gh"), status({ source: "gh" }));
  assert.equal((await statusOf([api, gh]))!.source, "gh");
  assert.deepEqual(calls, ["api", "gh"]);
  calls.length = 0;
  const works = async () => (calls.push("api"), status());
  assert.equal((await statusOf([works, gh]))!.source, "github");
  assert.deepEqual(calls, ["api"], "the second is not asked when the first answered");
  assert.equal(await statusOf([async () => { throw new Error("down"); }, async () => null]), null);
});

test("the API call reads the PR, its reviews and the checks on its head commit, and gives up quietly on a refusal", async () => {
  const urls: string[] = [];
  const fake = (async (u: string) => {
    urls.push(u);
    const body = u.endsWith("/pulls/7") ? { state: "open", draft: false, mergeable: true, head: { sha: "abc" } } : u.includes("/reviews") ? [{ user: { login: "ann" }, state: "APPROVED" }] : { check_runs: [{ status: "completed", conclusion: "success" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const got = await fromGithubApi("tok", "https://github.com/acme/api/pull/7", fake);
  assert.deepEqual([got?.review, got?.checks, got?.source], ["approved", "passing", "github"]);
  assert.ok(urls.some((u) => u.endsWith("/commits/abc/check-runs?per_page=100")));
  const refuse = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(fromGithubApi("bad", "https://github.com/acme/api/pull/7", refuse));
  assert.equal(await fromGithubApi("tok", "https://example.com/not-a-pr", fake), null);
});

test("what GitHub says moves the card: done, needs you, ready to merge, or waiting", () => {
  let seq = 0;
  const ev = (body: EventBody): SessionEvent => ({ seq: ++seq, ts: 1000 + seq, actor: { id: "x", name: "X", kind: "human" }, body });
  const s = { ...initialState("s1"), title: "Fix checkout", driver: { id: "me", name: "Me" } };
  const card = boardCards(s, [ev({ type: "folder.committed", sha: "a".repeat(40), branch: "friday/x", message: "x", files: 1, pushed: true, prUrl: "https://github.com/acme/api/pull/9", prCreated: true })], "me")[0]!;
  assert.equal(card.column, "review");
  const at = (over: Partial<PrStatus>) => applyPrStatus(card, status(over));
  assert.deepEqual([at({ state: "merged" }).column, at({ state: "merged" }).status], ["idle", "Merged"]);
  assert.equal(at({ state: "closed" }).status, "Closed");
  assert.deepEqual([at({ checks: "failing" }).column, at({ checks: "failing" }).status, at({ checks: "failing" }).you], ["needs", "CI failed", true]);
  assert.equal(at({ review: "changes_requested" }).status, "Changes requested");
  assert.equal(at({ mergeable: false }).status, "Merge conflicts");
  assert.deepEqual([at({ review: "approved", checks: "passing" }).column, at({ review: "approved", checks: "passing" }).status], ["ready", "Ready to merge"]);
  assert.equal(at({ review: "approved", checks: "pending" }).status, "Checks running", "approved but not yet green is not ready");
  assert.equal(at({ draft: true }).status, "Draft");
  assert.equal(at({ review: "review_required", checks: "passing" }).status, "Review pending");
});

test("a link that isn't a pull request is an answer, without asking gh", async () => {
  const { readRepo } = await import("../src/runner/repo-read.js");
  const out = await readRepo(process.cwd(), { op: "prstatus", query: "not a url", mode: "plan" });
  assert.match(out, /isn't a GitHub pull request link/);
  assert.equal(fromGh(JSON.parse(out)), null);
});

// A stand-in gh is a script on PATH, and on Windows execFile runs only a real .exe, so it would find the installed gh instead.
test("the runner asks the person's own gh, read-only, and a missing gh is an answer the server passes over", { skip: process.platform === "win32" && "a stand-in gh can't be put on PATH on Windows" }, async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { readRepo } = await import("../src/runner/repo-read.js");
  const dir = await mkdtemp(path.join(tmpdir(), "fake-gh-"));
  const was = process.env.PATH;
  t.after(async () => {
    process.env.PATH = was;
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await writeFile(path.join(dir, "gh"), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeable: "MERGEABLE", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }));\n`);
  await chmod(path.join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}${path.delimiter}${was}`;
  const out = await readRepo(dir, { op: "prstatus", query: "https://github.com/acme/api/pull/3", mode: "plan" });
  assert.deepEqual([fromGh(JSON.parse(out))?.review, fromGh(JSON.parse(out))?.source], ["approved", "gh"]);
});

test("Code Review: GitHub's search answer becomes three lists, with checks, review and conflicts said in a word", async () => {
  const { prsFromGraphql, prSearches } = await import("../src/runner/workspace.js");
  const node = (over: Record<string, unknown> = {}) => ({
    number: 7, title: "Fix it", url: "https://github.com/a/b/pull/7", isDraft: false, updatedAt: "2026-10-09T10:00:00Z", headRefName: "fix",
    reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", additions: 3, deletions: 1, repository: { nameWithOwner: "a/b" },
    author: { login: "ann", avatarUrl: "https://x/a.png" }, comments: { totalCount: 2 }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] }, ...over,
  });
  const got = prsFromGraphql({ data: { viewer: { login: "me" }, mine: { nodes: [node(), {}] }, review: { nodes: [node({ reviewDecision: "REVIEW_REQUIRED", mergeable: "UNKNOWN", commits: { nodes: [] } })] }, merged: { nodes: [node({ mergedAt: "2026-10-08T00:00:00Z", reviewDecision: "APPROVED" })] } } });
  assert.equal(got.account, "me");
  assert.equal(got.mine.length, 1, "a search hit that isn't a pull request is left out");
  assert.deepEqual([got.mine[0]!.checks, got.mine[0]!.review, got.mine[0]!.mergeable, got.mine[0]!.repo], ["failing", "changes_requested", false, "a/b"]);
  assert.deepEqual([got.review[0]!.checks, got.review[0]!.review, got.review[0]!.mergeable], ["none", "review_required", null]);
  assert.equal(got.merged[0]!.mergedAt, "2026-10-08T00:00:00Z");
  assert.deepEqual(prsFromGraphql(null), { mine: [], review: [], merged: [] }, "no answer is three empty lists");
  assert.match(prSearches(Date.parse("2026-10-10T12:00:00Z")).merged, /merged:>=2026-10-03/, "this week's merges");
});
