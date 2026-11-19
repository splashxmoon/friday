// A pull request in full for the Pull request panel (pr-detail.ts; Arun, 2026-11-19: "a more better design of this, with more
// details and info and stuff like how others do it"), read from `gh pr view --json` as it really answers.
import assert from "node:assert/strict";
import test from "node:test";
import { checkState, prDetailFromGh } from "../src/pr-detail.js";

const GH = {
  number: 11,
  title: "test: add unit tests for splitCommandLine",
  body: "Closes #3.\n\n## What\nSix cases.",
  author: { id: "U_1", is_bot: false, login: "yudhapakel", name: "" },
  baseRefName: "main",
  headRefName: "test/split-command-line",
  createdAt: "2026-11-02T23:01:20Z",
  updatedAt: "2026-11-02T23:42:09Z",
  mergedAt: "2026-11-02T23:42:09Z",
  closedAt: "2026-11-02T23:42:09Z",
  mergedBy: { id: "M_1", is_bot: false, login: "splashxmoon", name: "Arun Dass" },
  mergeCommit: { oid: "aa09b005627949f3e98268423e7edc71db692336" },
  additions: 45,
  deletions: 2,
  changedFiles: 2,
  labels: [{ id: "L1", name: "tests", color: "0e8a16", description: "" }, { name: "bad color", color: "zzz" }],
  assignees: [{ login: "splashxmoon", name: "Arun Dass" }],
  reviewRequests: [{ __typename: "User", login: "kit-dev" }, { __typename: "Team", name: "Core", slug: "core" }],
  latestReviews: [{ author: { login: "splashxmoon" }, body: "thanks, exactly what #3 asked for", submittedAt: "2026-11-02T23:38:40Z", state: "COMMENTED" }, { author: { login: "kit-dev" }, body: "", submittedAt: "2026-11-02T23:39:00Z", state: "APPROVED" }],
  closingIssuesReferences: [{ number: 3, repository: { name: "friday", owner: { login: "splashxmoon" } }, url: "https://github.com/splashxmoon/friday/issues/3" }],
  commits: [
    { authoredDate: "2026-11-02T22:59:13Z", authors: [{ email: "someone@example.com", login: "yudhapakel", name: "Yudha" }], committedDate: "2026-11-02T22:59:13Z", messageHeadline: "test: add unit tests", oid: "90380453483a9b93101a3264da2fa4712f53dddf" },
  ],
  files: [{ path: "test/split-command-line.test.ts", additions: 45, deletions: 0, changeType: "ADDED" }, { path: "src/x.ts", additions: 0, deletions: 2, changeType: "MODIFIED" }],
  statusCheckRollup: [
    { __typename: "CheckRun", completedAt: "2026-11-02T23:39:48Z", conclusion: "SUCCESS", detailsUrl: "https://github.com/a/b/actions/runs/1/job/2", name: "check (ubuntu-latest)", startedAt: "2026-11-02T23:37:43Z", status: "COMPLETED", workflowName: "CI" },
    { __typename: "CheckRun", conclusion: "", name: "check (windows-latest)", startedAt: "2026-11-02T23:37:43Z", status: "IN_PROGRESS", workflowName: "CI" },
    { __typename: "StatusContext", context: "vercel", state: "FAILURE", targetUrl: "https://vercel.com/x" },
  ],
  comments: 4,
  mergeStateStatus: "CLEAN",
};

test("gh's pull request is read into what the panel draws, with nobody's email", () => {
  const d = prDetailFromGh(GH)!;
  assert.equal(d.number, 11);
  assert.equal(d.author?.login, "yudhapakel");
  assert.equal(d.author?.name, undefined, "an empty name is no name");
  assert.equal(d.mergedBy?.name, "Arun Dass");
  assert.equal(d.mergeCommit, "aa09b005627949f3e98268423e7edc71db692336");
  assert.equal(d.mergedAt, Date.parse("2026-11-02T23:42:09Z"));
  assert.deepEqual(d.labels, [{ name: "tests", color: "0e8a16" }, { name: "bad color", color: "888888" }]);
  assert.deepEqual(d.closes, [{ number: 3, url: "https://github.com/splashxmoon/friday/issues/3", repo: "splashxmoon/friday" }]);
  // Each reviewer's last say, then those asked who haven't answered: the approval stands for kit-dev, the team is asked.
  assert.deepEqual(d.reviewers.map((r) => [r.who.login, r.state]), [["splashxmoon", "commented"], ["kit-dev", "approved"], ["core", "pending"]]);
  assert.equal(d.reviewers[0]!.body, "thanks, exactly what #3 asked for");
  assert.equal(d.commitCount, 1);
  assert.deepEqual(d.commits[0], { sha: "90380453483a9b93101a3264da2fa4712f53dddf", headline: "test: add unit tests", who: "Yudha", login: "yudhapakel", at: Date.parse("2026-11-02T22:59:13Z") });
  assert.ok(!JSON.stringify(d).includes("@example.com"), "no email");
  assert.deepEqual(d.files.map((f) => f.change), ["added", "modified"]);
  assert.deepEqual(d.checks.map((c) => [c.name, c.state, c.workflow ?? ""]), [["check (ubuntu-latest)", "pass", "CI"], ["check (windows-latest)", "pending", "CI"], ["vercel", "fail", ""]]);
  assert.equal(d.checks[0]!.completedAt! - d.checks[0]!.startedAt!, 125_000);
  assert.equal(d.checks[2]!.link, "https://vercel.com/x");
  assert.equal(d.comments, 4);
  assert.equal(d.mergeState, "CLEAN");
});

test("a check's word: failed beats running beats passed; skipped and neutral apart", () => {
  assert.equal(checkState({ status: "COMPLETED", conclusion: "TIMED_OUT" }), "fail");
  assert.equal(checkState({ status: "QUEUED", conclusion: null }), "pending");
  assert.equal(checkState({ state: "PENDING" }), "pending");
  assert.equal(checkState({ status: "COMPLETED", conclusion: "SKIPPED" }), "skip");
  assert.equal(checkState({ status: "COMPLETED", conclusion: "NEUTRAL" }), "neutral");
  assert.equal(checkState({ state: "SUCCESS" }), "pass");
});

test("anything that isn't a pull request is nothing, and links that aren't GitHub's are dropped", () => {
  assert.equal(prDetailFromGh(null), null);
  assert.equal(prDetailFromGh({ error: "gh isn't signed in" }), null);
  assert.equal(prDetailFromGh({ title: "no number" }), null);
  const d = prDetailFromGh({ number: 2, closingIssuesReferences: [{ number: 9, url: "javascript:alert(1)" }], statusCheckRollup: [{ name: "x", conclusion: "SUCCESS", detailsUrl: "javascript:alert(1)" }] })!;
  assert.deepEqual(d.closes, []);
  assert.equal(d.checks[0]!.link, undefined);
  assert.deepEqual([d.labels, d.reviewers, d.commits, d.files, d.commitCount, d.comments], [[], [], [], [], 0, 0]);
});
