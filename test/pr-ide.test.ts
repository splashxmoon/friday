import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanContext, copyName, diffRows, draftsOf, filesArgs, headLine, lineOfPosition, positionOfLine, postArgs, replyRoute, reviewLabel, reviewPost, reviewRoute, splitDiff, threadsArgs, threadsOf, pagesOf, THREADS_QUERY, worthPosting, prRef } from "../src/pr-ide.js";

// Review a teammate's pull request in the IDE (Arun, 2026-11-19, wave 3): GitHub's diff positions and lines, its threads, the gh
// calls and the review that is posted.

// Two hunks: lines 3-7 of the old file become 3-8 (one line replaced, one added), then a deletion at the end.
const PATCH = [
  "@@ -3,5 +3,6 @@ function a() {",
  " keep three",
  "-old four",
  "+new four",
  "+new four b",
  " keep five",
  " keep six",
  " keep seven",
  "@@ -20,3 +21,2 @@ function b() {",
  " keep twenty",
  "-gone twenty-one",
  " keep twenty-two",
].join("\n");

test("positions count down from the first @@ line, and every later @@ counts too", () => {
  const rows = diffRows(PATCH + "\n");
  assert.deepEqual(rows.map((r) => r.pos), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(rows.slice(0, 5).map((r) => [r.kind, r.old, r.new]), [["hunk", undefined, undefined], ["ctx", 3, 3], ["del", 4, undefined], ["add", undefined, 4], ["add", undefined, 5]]);
  // The second hunk starts at old 20 / new 21.
  assert.deepEqual(rows[9], { pos: 9, kind: "ctx", old: 20, new: 21 });
  assert.deepEqual(rows[10], { pos: 10, kind: "del", old: 21 });
  assert.deepEqual(rows[11], { pos: 11, kind: "ctx", old: 22, new: 22 });
});

test("a GitHub position maps to the line of the file: new side for added and unchanged, old side for a deleted line", () => {
  assert.deepEqual(lineOfPosition(PATCH, 1), { line: 3, side: "RIGHT" });
  assert.deepEqual(lineOfPosition(PATCH, 2), { line: 4, side: "LEFT" });
  assert.deepEqual(lineOfPosition(PATCH, 3), { line: 4, side: "RIGHT" });
  assert.deepEqual(lineOfPosition(PATCH, 4), { line: 5, side: "RIGHT" });
  assert.deepEqual(lineOfPosition(PATCH, 10), { line: 21, side: "LEFT" });
  assert.equal(lineOfPosition(PATCH, 0), null, "the @@ line has no position");
  assert.equal(lineOfPosition(PATCH, 8), null, "the second @@ line is a position, and nothing to comment on");
  assert.equal(lineOfPosition(PATCH, 99), null);
});

test("a line maps back to its position, and a line outside the diff has none", () => {
  assert.equal(positionOfLine(PATCH, 4, "RIGHT"), 3);
  assert.equal(positionOfLine(PATCH, 4, "LEFT"), 2);
  assert.equal(positionOfLine(PATCH, 21, "RIGHT"), 9);
  assert.equal(positionOfLine(PATCH, 21, "LEFT"), 10);
  assert.equal(positionOfLine(PATCH, 12, "RIGHT"), null, "between the hunks");
  assert.equal(positionOfLine(PATCH, 1), null);
  // Every position that has a line maps back to itself.
  for (const r of diffRows(PATCH)) {
    const at = lineOfPosition(PATCH, r.pos);
    if (at) assert.equal(positionOfLine(PATCH, at.line, at.side), r.pos);
  }
});

test("a no-newline marker takes a position and is no line", () => {
  const p = ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"].join("\n");
  const rows = diffRows(p);
  assert.deepEqual(rows.map((r) => r.kind), ["hunk", "ctx", "del", "meta", "add", "meta"]);
  assert.equal(positionOfLine(p, 2, "RIGHT"), 4);
  assert.equal(lineOfPosition(p, 3), null);
});

test("a comment on a deleted line is drawn at the line after it in the branch's file", () => {
  assert.deepEqual(headLine(PATCH, 4, "LEFT"), { line: 4, removed: true }, "the line that replaced it");
  assert.deepEqual(headLine(PATCH, 21, "LEFT"), { line: 22, removed: true });
  assert.deepEqual(headLine(PATCH, 5, "RIGHT"), { line: 5, removed: false });
  assert.equal(headLine(PATCH, 12, "RIGHT"), null);
  // A deletion at the very end: the last line before it.
  const end = ["@@ -1,2 +1,1 @@", " a", "-b"].join("\n");
  assert.deepEqual(headLine(end, 2, "LEFT"), { line: 1, removed: true });
});

const GRAPH = (nodes: unknown[]) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
const THREAD = (o: Record<string, unknown> = {}) => ({
  id: "PRRT_1",
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 5,
  originalLine: 5,
  startLine: null,
  diffSide: "RIGHT",
  subjectType: "LINE",
  comments: { nodes: [{ databaseId: 11, author: { login: "alice" }, body: "Why not a Map?", createdAt: "2026-11-18T10:00:00Z", url: "https://github.com/acme/web/pull/7#discussion_r11" }, { databaseId: 12, author: { login: "bob" }, body: "Order matters here.", createdAt: "2026-11-18T11:00:00Z" }] },
  ...o,
});

test("threads are read into the lines they are on, with their comments in order", () => {
  const [t] = threadsOf(GRAPH([THREAD()]));
  assert.equal(t!.path, "src/a.ts");
  assert.equal(t!.line, 5);
  assert.equal(t!.resolved, false);
  assert.deepEqual(t!.comments.map((c) => [c.id, c.author]), [[11, "alice"], [12, "bob"]]);
  assert.equal(t!.comments[0]!.at, Date.parse("2026-11-18T10:00:00Z"));
});

test("a thread on a deleted line is drawn on the line after it; an outdated one where it was; a file's on line 1", () => {
  const patches = { "src/a.ts": PATCH };
  const [left] = threadsOf(GRAPH([THREAD({ line: 4, diffSide: "LEFT" })]), patches);
  assert.equal(left!.line, 4);
  assert.equal(left!.removed, true);
  const [old] = threadsOf(GRAPH([THREAD({ line: null, originalLine: 9, isOutdated: true })]), patches);
  assert.deepEqual([old!.line, old!.outdated, old!.removed], [9, true, false]);
  const [file] = threadsOf(GRAPH([THREAD({ line: null, originalLine: null, subjectType: "FILE" })]));
  assert.deepEqual([file!.line, file!.file], [1, true]);
  const [many] = threadsOf(GRAPH([THREAD({ line: 8, startLine: 6 })]));
  assert.equal(many!.startLine, 6);
});

test("what is not a thread is left out, and nothing breaks on a bad answer", () => {
  assert.deepEqual(threadsOf(GRAPH([THREAD({ path: "" }), THREAD({ comments: { nodes: [] } }), null, "x"])), []);
  assert.deepEqual(threadsOf(null), []);
  assert.deepEqual(threadsOf({ data: {} }), []);
  const [t] = threadsOf(GRAPH([THREAD({ comments: { nodes: [{ databaseId: 1, author: null, body: "hi" }] } })]));
  assert.equal(t!.comments[0]!.author, "someone");
});

const REF = prRef("https://github.com/acme/web/pull/7");

test("the gh calls: the owner and name are strings whatever they look like, the number an integer, and a post takes its JSON on stdin", () => {
  assert.deepEqual(prRef("https://github.com/123/456/pull/7/files"), { owner: "123", repo: "456", number: 7 });
  const a = threadsArgs({ owner: "123", repo: "456", number: 7 });
  assert.deepEqual(a.slice(0, 2), ["api", "graphql"]);
  assert.ok(a.includes("owner=123") && a[a.indexOf("owner=123") - 1] === "-f", "owner is -f: never read as a number");
  assert.ok(a[a.indexOf("number=7") - 1] === "-F");
  assert.deepEqual(filesArgs(REF), ["api", "repos/acme/web/pulls/7/files?per_page=100", "--paginate"]);
  assert.deepEqual(postArgs("/repos/acme/web/pulls/7/reviews"), ["api", "--method", "POST", "repos/acme/web/pulls/7/reviews", "--input", "-"]);
  assert.equal(reviewRoute(REF), "repos/acme/web/pulls/7/reviews");
  assert.equal(replyRoute(REF, 11.9), "repos/acme/web/pulls/7/comments/11/replies");
  assert.throws(() => prRef("https://example.com/x"), /pull request link/);
  // No comment's words are ever an argument.
  const post = reviewPost(REF, { event: "COMMENT", body: "--evil $(x)", comments: [{ path: "src/a.ts", line: 4, body: "`rm -rf`" }], replies: [{ to: 11, body: "; ls" }] }, { "src/a.ts": PATCH });
  for (const args of [postArgs(reviewRoute(REF)), ...post.replies.map((r) => postArgs(r.route))]) assert.ok(!args.join(" ").includes("evil") && !args.join(" ").includes("rm -rf"));
});

test("the review posted: verdict, words, comments on lines of the new side, the commit it is of", () => {
  const post = reviewPost(REF, { head: "abc1234", event: "REQUEST_CHANGES", body: "  Needs a test.  ", comments: [{ path: "src/a.ts", line: 4, body: "Use a Map" }, { path: "src/a.ts", line: 5, startLine: 4, body: "These two" }], replies: [{ to: 11, body: "Agreed" }] }, { "src/a.ts": PATCH });
  assert.deepEqual(post.review, {
    event: "REQUEST_CHANGES",
    body: "Needs a test.",
    commit_id: "abc1234",
    comments: [
      { path: "src/a.ts", line: 4, side: "RIGHT", body: "Use a Map" },
      { path: "src/a.ts", line: 5, side: "RIGHT", body: "These two", start_line: 4, start_side: "RIGHT" },
    ],
  });
  assert.deepEqual(post.replies, [{ route: "repos/acme/web/pulls/7/comments/11/replies", to: 11, payload: { body: "Agreed" } }]);
  assert.equal(post.moved.length, 0);
});

test("a comment GitHub would refuse goes into the review's own words, so the rest still lands", () => {
  const post = reviewPost(REF, { event: "COMMENT", body: "Overall fine.", comments: [{ path: "src/a.ts", line: 12, body: "Between hunks" }, { path: "docs/x.md", line: 1, body: "Not in the change" }, { path: "src/a.ts", line: 4, body: "Fine" }], replies: [] }, { "src/a.ts": PATCH });
  assert.deepEqual((post.review.comments as unknown[]).length, 1);
  assert.match(String(post.review.body), /Overall fine\.\n\n\*\*src\/a\.ts:12\*\*\nBetween hunks\n\n\*\*docs\/x\.md:1\*\*\nNot in the change/);
  assert.equal(post.moved.length, 2);
});

test("a review says something: changes need words, a bare comment is nothing, an approval alone is fine", () => {
  assert.throws(() => reviewPost(REF, { event: "REQUEST_CHANGES", body: " ", comments: [], replies: [] }, {}), /what should change/);
  assert.throws(() => reviewPost(REF, { event: "COMMENT", body: "", comments: [], replies: [] }, {}), /nothing to post/);
  assert.doesNotThrow(() => reviewPost(REF, { event: "APPROVE", body: "", comments: [], replies: [] }, {}));
  assert.doesNotThrow(() => reviewPost(REF, { event: "COMMENT", body: "", comments: [], replies: [{ to: 3, body: "ok" }] }, {}));
  assert.throws(() => reviewPost(REF, { event: "MERGE" as never, body: "x", comments: [], replies: [] }, {}), /Approve/);
  assert.equal(worthPosting({ event: "COMMENT", body: "", comments: [], replies: [] }), false);
  assert.equal(worthPosting({ event: "APPROVE", body: "", comments: [], replies: [] }), true);
  // Blank comments and replies are dropped, not posted.
  const post = reviewPost(REF, { event: "APPROVE", body: "", comments: [{ path: "src/a.ts", line: 4, body: "  " }], replies: [{ to: 0, body: "x" }, { to: 3, body: " " }] }, { "src/a.ts": PATCH });
  assert.deepEqual(post.review, { event: "APPROVE" });
  assert.deepEqual(post.replies, []);
});

test("an agent's findings become drafts on lines of the change; the rest is left loose", () => {
  const f = (o: Record<string, unknown>) => ({ severity: "high", title: "T", detail: "D", ...o }) as never;
  const { drafts, loose } = draftsOf([f({ path: "src/a.ts", line: 4, title: "Race" }), f({ path: "a.ts", line: 5, severity: "low" }), f({ path: "src/a.ts", line: 12 }), f({ path: "nope.ts", line: 1 }), f({ path: "src/a.ts" }), f({})], { "src/a.ts": PATCH });
  assert.deepEqual(drafts.map((d) => [d.path, d.line, d.severity]), [["src/a.ts", 4, "high"], ["src/a.ts", 5, "low"]]);
  assert.equal(drafts[0]!.body, "Race\n\nD");
  assert.equal(loose.length, 4);
});

test("a git diff is cut into files with the hunks GitHub calls a patch", () => {
  const raw = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    PATCH,
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..333",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "diff --git a/x.ts b/y.ts",
    "similarity index 90%",
    "rename from x.ts",
    "rename to y.ts",
    "",
  ].join("\n");
  const files = splitDiff(raw);
  assert.deepEqual(files.map((x) => [x.path, x.status, x.patch.startsWith("@@") || x.patch === ""]), [["src/a.ts", "modified", true], ["new.txt", "added", true], ["old.txt", "deleted", true], ["img.png", "modified", true], ["y.ts", "renamed", true]]);
  assert.equal(files[0]!.patch, PATCH);
  assert.equal(positionOfLine(files[1]!.patch, 2, "RIGHT"), 2);
});

test("the copy's name ends as every copy of Friday's does, and a context keeps only what it should", () => {
  assert.match(`${copyName("My Web.App", 12)}-1a2b3c4d`, /^my-web-app-pr12-[0-9a-f]{8}$/);
  // The owner is in it: a fork's #5 and its upstream's #5 are two folders.
  assert.match(`${copyName("friday", 5, "splashxmoon")}-1a2b3c4d`, /^splashxmoon-friday-pr5-[0-9a-f]{8}$/);
  assert.notEqual(copyName("friday", 5, "me"), copyName("friday", 5, "splashxmoon"));
  assert.equal(reviewLabel(7, "Add the\ncache"), "PR #7 · Add the cache");
  assert.equal(reviewLabel(7, "").startsWith("PR #7"), true);
  assert.ok(reviewLabel(7, "x".repeat(200)).length <= 60);
  assert.equal(cleanContext({ url: "nope", dir: "/x" }), null);
  assert.equal(cleanContext({ url: "https://github.com/a/b/pull/3" }), null);
  const c = cleanContext({ url: "https://github.com/a/b/pull/3", dir: "/w/b-pr3-1a2b3c4d", sha: "zzz", title: "T", token: "secret", me: "me" })!;
  assert.deepEqual(Object.keys(c).sort(), ["author", "base", "dir", "head", "me", "number", "owner", "repo", "sha", "title", "url"]);
  assert.equal(c.sha, "", "not a commit");
  assert.equal(c.number, 3);
});

test("a left-pane comment on an unchanged line stays on that line; one on a removed line goes to the line after", () => {
  const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c";
  assert.deepEqual(headLine(patch, 1, "LEFT"), { line: 1, removed: false }, "context line: not 'removed'");
  assert.deepEqual(headLine(patch, 2, "LEFT"), { line: 2, removed: true });
  assert.deepEqual(headLine(patch, 3, "LEFT"), { line: 3, removed: false }, "the old line 3 is the new line 3");
});

test("every page of threads is read, and a thread with more comments than were read says so", () => {
  const node = (id: string, total = 1) => ({ id, path: "a.ts", line: 3, diffSide: "RIGHT", comments: { totalCount: total, nodes: [{ databaseId: 1, author: { login: "x" }, body: "hi", createdAt: "2026-11-18T10:00:00Z" }] } });
  const page = (nodes: unknown[], next: boolean) => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next, endCursor: "c" }, nodes } } } } });
  // gh --paginate writes the pages one after the other (braces and quotes inside the words included).
  const raw = JSON.stringify(page([node("A"), node("B", 80)], true)).replace('"hi"', '"a } { \\" brace"') + "\n" + JSON.stringify(page([node("C")], false));
  const pages = pagesOf(raw);
  assert.equal(pages.length, 2);
  const threads = threadsOf(pages);
  assert.deepEqual(threads.map((t) => [t.id, !!t.more]), [["A", false], ["B", true], ["C", false]]);
  assert.match(threads[0]!.comments[0]!.body, /brace/);
  assert.deepEqual(pagesOf(""), []);
  assert.deepEqual(pagesOf("nope"), []);
  // The query follows the cursor, and the call asks gh to.
  assert.match(THREADS_QUERY, /\$endCursor:String/);
  assert.match(THREADS_QUERY, /after:\$endCursor/);
  assert.match(THREADS_QUERY, /pageInfo\{hasNextPage endCursor\}/);
  assert.ok(threadsArgs({ owner: "a", repo: "b", number: 1 }).includes("--paginate"));
});
