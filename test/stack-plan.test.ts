import assert from "node:assert/strict";
import { test } from "node:test";
import { reachForMessage } from "../src/client/smartReach.js";
import { checksState, isBig, mergeStackPart, moveStackPart, parseStack, partDetail, planRestack, planStack, restackHandoff, slug, STACK_ASK, STACK_FENCE, stackBody, stackBranches, stackCounts } from "../src/stack-plan.js";

const plan = parseStack(JSON.stringify({ parts: [{ title: "Add the queue", why: "The store the rest uses.", files: ["src/queue.ts", "test/queue.test.ts"] }, { title: "Use it in the worker", why: "", files: ["src/worker.ts"] }, { title: "Docs", why: "How it works.", files: ["docs/queue.md"] }] }))!;

test("a proposal is read, with bad parts made safe", () => {
  const p = parseStack(
    JSON.stringify({
      parts: [
        { title: "  One\nline ", why: " why ", files: ["./a.ts", "b\\c.ts", "/etc/passwd", "../out.ts", "-rf", "C:\\x.ts", "a.ts", 7, null, "dir//x.ts"] },
        { title: "", files: ["b/c.ts", "d.ts"] },
        { title: "Empty", files: [] },
        { title: "No files at all" },
        "nope",
        null,
      ],
    }),
  )!;
  assert.deepEqual(p.parts[0], { title: "One line", why: "why", files: ["a.ts", "b/c.ts"] });
  // A file is in one part only (the first that names it keeps it), and a part with nothing left is dropped; a missing title is its number.
  assert.deepEqual(p.parts[1], { title: "Part 2", why: "", files: ["d.ts"] });
  assert.equal(p.parts.length, 2);
  assert.equal(parseStack("not json"), null);
  assert.equal(parseStack(JSON.stringify({ parts: [] })), null);
  assert.equal(parseStack(JSON.stringify({ nothing: 1 })), null);
  assert.equal(parseStack(JSON.stringify([{ title: "A bare list", files: ["x.ts"] }]))!.parts.length, 1);
});

test("a proposal is capped at twelve parts", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `P${i}`, files: [`f${i}.ts`] }));
  assert.equal(parseStack(JSON.stringify({ parts: many }))!.parts.length, 12);
});

test("a change is big over 400 lines or 10 files", () => {
  const f = (n: number, add: number, del = 0) => Array.from({ length: n }, () => ({ additions: add, deletions: del }));
  assert.equal(isBig(f(3, 100)), false);
  assert.equal(isBig(f(3, 100, 40)), true);
  assert.equal(isBig(f(10, 1)), false);
  assert.equal(isBig(f(11, 1)), true);
  assert.equal(isBig([]), false);
});

test("parts move and merge, and the plan is never changed in place", () => {
  const down = moveStackPart(plan, 0, 1);
  assert.deepEqual(down.parts.map((p) => p.title), ["Use it in the worker", "Add the queue", "Docs"]);
  assert.deepEqual(plan.parts.map((p) => p.title), ["Add the queue", "Use it in the worker", "Docs"]);
  assert.equal(moveStackPart(plan, 0, -1), plan, "the first can't go up");
  assert.equal(moveStackPart(plan, 2, 1), plan, "the last can't go down");
  const up = mergeStackPart(plan, 1, -1);
  assert.equal(up.parts.length, 2);
  assert.deepEqual(up.parts[0], { title: "Add the queue", why: "The store the rest uses.", files: ["src/queue.ts", "test/queue.test.ts", "src/worker.ts"] });
  const next = mergeStackPart(plan, 1, 1);
  assert.deepEqual(next.parts.map((p) => p.title), ["Add the queue", "Use it in the worker"]);
  assert.deepEqual(next.parts[1]!.files, ["src/worker.ts", "docs/queue.md"]);
  assert.equal(next.parts[1]!.why, "How it works.");
  assert.equal(mergeStackPart(plan, 0, -1), plan);
  assert.equal(mergeStackPart(plan, 2, 1), plan);
  assert.equal(stackCounts(plan), "3 parts · 4 files");
  assert.equal(stackCounts(mergeStackPart(plan, 1, -1)), "2 parts · 4 files");
});

test("branches are named from the person's own, and never land on ones that exist", () => {
  assert.deepEqual(stackBranches("feat/queue", "main", "x", 3), { prefix: "feat/queue", names: ["feat/queue-1", "feat/queue-2", "feat/queue-3"] });
  // On the base branch itself the title names the stack.
  assert.deepEqual(stackBranches("main", "main", "Add the queue!", 2), { prefix: "stack/add-the-queue", names: ["stack/add-the-queue-1", "stack/add-the-queue-2"] });
  assert.equal(stackBranches("", "main", "", 2).prefix, "stack/changes");
  assert.equal(stackBranches("HEAD", "main", "T", 2).prefix, "stack/t");
  // A second stack from the same branch gets a prefix of its own.
  assert.equal(stackBranches("feat/queue", "main", "x", 3, ["feat/queue-2"]).prefix, "feat/queue-v2");
  assert.equal(slug("  Add the Retry-Queue (v2)!  "), "add-the-retry-queue-v2");
});

test("making the stack: every branch first, then the pushes, then the pull requests, bottom first, each on the one below", () => {
  const names = ["s-1", "s-2", "s-3"];
  const steps = planStack(plan, names, "main");
  assert.deepEqual(
    steps.map((s) => (s.kind === "links" ? "links" : `${s.kind}:${s.kind === "pr" ? s.head : s.branch}`)),
    ["commit:s-1", "commit:s-2", "commit:s-3", "push:s-1", "push:s-2", "push:s-3", "pr:s-1", "pr:s-2", "pr:s-3", "links"],
  );
  const commits = steps.filter((s) => s.kind === "commit");
  assert.deepEqual(commits.map((s) => s.kind === "commit" && s.below), [null, "s-1", "s-2"], "part 1 starts on the base, each next on the one before");
  assert.deepEqual(commits.map((s) => s.kind === "commit" && s.files), [["src/queue.ts", "test/queue.test.ts"], ["src/worker.ts"], ["docs/queue.md"]]);
  const prs = steps.filter((s) => s.kind === "pr");
  assert.deepEqual(prs.map((s) => s.kind === "pr" && s.base), ["main", "s-1", "s-2"], "--base is the part below");
  assert.match((prs[1] as { body: string }).body, /^Part 2 of 3 in a stack of pull requests\./);
  assert.match((prs[1] as { body: string }).body, /based on part 1 \(Add the queue\)/);
  assert.match((commits[2] as { message: string }).message, /^Docs\n\nPart 3 of 3/);
});

test("a description says its place and links the others once their links are known", () => {
  const body = stackBody(1, plan, ["https://x/pull/1", undefined, undefined], "main");
  assert.match(body, /Part 2 of 3/);
  assert.match(body, /1\. \[Add the queue\]\(https:\/\/x\/pull\/1\)/);
  assert.match(body, /2\. \*\*Use it in the worker\*\* \(this pull request\)/);
  assert.match(body, /3\. Docs/);
  assert.match(body, /so merge that one first/);
  assert.doesNotMatch(body, /\n\n\n/);
  assert.match(stackBody(0, plan, [], "main"), /based on `main`/);
});

test("restacking: each open part onto the one below, a merged part drops out and the one above goes onto the base", () => {
  const all = planRestack([{ branch: "s-1", state: "open" }, { branch: "s-2", state: "open" }, { branch: "s-3", state: "unknown" }], "main");
  assert.deepEqual(all.map((s) => s.kind === "rebase" && [s.branch, s.onto, s.retarget]), [["s-1", "main", "main"], ["s-2", "s-1", "s-1"], ["s-3", "s-2", "s-2"]]);
  const merged = planRestack([{ branch: "s-1", state: "merged" }, { branch: "s-2", state: "open" }, { branch: "s-3", state: "open" }], "main");
  assert.deepEqual(merged[0], { kind: "skip", part: 1, branch: "s-1", why: "Merged" });
  assert.deepEqual(merged.slice(1).map((s) => s.kind === "rebase" && [s.branch, s.onto]), [["s-2", "main"], ["s-3", "s-2"]]);
  const middle = planRestack([{ branch: "s-1", state: "open" }, { branch: "s-2", state: "merged" }, { branch: "s-3", state: "open" }], "main");
  assert.deepEqual(middle.map((s) => s.kind === "rebase" && s.onto), [("main"), false, "s-1"]);
});

test("checks are one word", () => {
  assert.equal(checksState([]), "none");
  assert.equal(checksState(null), "none");
  assert.equal(checksState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), "pass");
  assert.equal(checksState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }]), "pending");
  assert.equal(checksState([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "fail");
  assert.equal(checksState([{ state: "SUCCESS" }]), "pass");
  assert.equal(checksState([{ state: "PENDING" }]), "pending");
  assert.equal(checksState([{ state: "ERROR" }]), "fail");
});

test("the stack view's line for a part says only what is worth a word", () => {
  assert.equal(partDetail({ pr: 12, state: "open", checks: "pass", ahead: 1, behind: 2, pushed: true }), "#12 · 2 behind");
  assert.equal(partDetail({ pr: 12, state: "open", checks: "pass", ahead: 1, behind: 0, pushed: true }), "#12");
  assert.equal(partDetail({ pr: 13, state: "open", checks: "fail", ahead: 1, behind: 0, pushed: true }), "#13 · checks failing");
  assert.equal(partDetail({ pr: 13, state: "open", checks: "pending", ahead: 1, behind: 1, pushed: true }), "#13 · checks running · 1 behind");
  assert.equal(partDetail({ pr: 14, state: "merged", checks: "pass", ahead: 0, behind: 3, pushed: true }), "#14 · merged");
  assert.equal(partDetail({ pr: null, state: "unknown", checks: "unknown", ahead: 0, behind: 0, pushed: false }), "not pushed");
  assert.equal(partDetail({ pr: null, state: "unknown", checks: "unknown", ahead: 0, behind: 0, pushed: true }), "no pull request");
});

test("the ask keeps the agent reading, asks for the fence, and the conflict hand-off keeps the checkout alone", () => {
  assert.ok(STACK_ASK.includes(STACK_FENCE));
  assert.equal(reachForMessage(STACK_ASK)?.mode, "plan");
  assert.doesNotMatch(STACK_ASK, /ExitPlanMode/);
  assert.match(STACK_ASK, /^Split into a stack\n/);
  const h = restackHandoff({ part: 2, total: 3, branch: "s-2", onto: "s-1", ontoRef: "refs/heads/s-1", files: ["a.ts", "b.ts"], recorded: "abc123" });
  assert.match(h, /^Restack part 2 of 3\n/);
  assert.match(h, /SEPARATE worktree/);
  assert.match(h, /`a\.ts`, `b\.ts`/);
  assert.match(h, /git rebase --onto refs\/heads\/s-1 abc123/);
  assert.match(h, /--force-with-lease origin s-2/);
  // It is work to do, not a read: the agent isn't put in Plan, where it couldn't do it.
  assert.notEqual(reachForMessage(h)?.mode, "plan");
});
