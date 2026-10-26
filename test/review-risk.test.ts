import assert from "node:assert/strict";
import test from "node:test";
import { applyPrStatus, boardCards, reviewFacts, sortCards, type BoardCard } from "../src/board.js";
import { byRisk, riskOf, riskOfPr } from "../src/review-risk.js";
import { initialState, project } from "../src/session/projection.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const f = (path: string, additions = 4, deletions = 1) => ({ path, additions, deletions });

test("risk: a small, tested change with nothing found is quick to review", () => {
  const r = riskOf({ files: [f("src/greeting.ts"), f("test/greeting.test.ts")], tests: "pass", checks: "passing" });
  assert.equal(r.level, "low");
  assert.equal(r.quick, true);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.top, "Tests pass", "a change with nothing against it says what there is for it");
  assert.equal(riskOf({ files: [f("README.md", 3, 0)] }).quick, true, "docs with no tests run are not held up for tests");
});

test("risk: sensitive paths are named, billing and auth first", () => {
  const billing = riskOf({ files: [f("src/billing.ts")], tests: "pass" });
  assert.equal(billing.top, "Touches billing");
  assert.equal(billing.quick, false, "one line in billing is never waved through with the rest");
  assert.equal(riskOf({ files: [f("src/auth/login.ts")] }).top, "Touches auth");
  assert.equal(riskOf({ files: [f("db/migrations/004_add_plan.sql")] }).top, "Has a migration");
  assert.equal(riskOf({ files: [f(".github/workflows/ci.yml")] }).top, "Changes CI");
  assert.equal(riskOf({ files: [f("package-lock.json", 300, 200)] }).reasons[0], "Changes dependencies");
  assert.equal(riskOf({ files: [f("src/author-card.tsx")], tests: "pass" }).quick, true, "an author card isn't auth");
});

test("risk: tests and checks that failed or never ran outweigh size", () => {
  const notRun = riskOf({ files: [f("src/cart.ts")], tests: "none" });
  assert.equal(notRun.top, "Tests not run");
  assert.equal(notRun.quick, false);
  assert.equal(riskOf({ files: [f("src/cart.ts")], tests: "fail" }).top, "Tests failing");
  assert.equal(riskOf({ files: [f("src/cart.ts")], tests: "pass", checks: "failing" }).top, "Checks failing");
  assert.equal(riskOf({ files: [f("src/cart.ts")] }).reasons.length, 0, "unknown tests are not counted against it");
  const big = riskOf({ files: [f("src/a.ts", 900, 300)], tests: "fail" });
  assert.deepEqual(big.reasons, ["Tests failing", "1,200 lines"]);
  assert.equal(big.level, "high");
});

test("risk: the receipt and the second reviewer weigh in, without the path in the chip", () => {
  const skipped = riskOf({ files: [f("src/cart.ts")], tests: "pass", flags: [{ level: "bad", text: "Switched off a test in test/cart.test.ts" }] });
  assert.equal(skipped.top, "Switched off a test");
  assert.equal(skipped.quick, false);
  const found = riskOf({ files: [f("src/cart.ts")], tests: "pass", findings: [{ severity: "high", title: "Total can go negative", detail: "" }] });
  assert.equal(found.top, "Reviewer: Total can go negative");
  assert.equal(found.quick, false);
  assert.equal(riskOf({ files: [f("src/cart.ts")], tests: "pass", findings: [{ severity: "low", title: "Typo", detail: "" }] }).quick, true, "a low note doesn't hold it up");
  // "Changed code and ran no tests" is the same fact as tests: "none": counted once.
  const once = riskOf({ files: [f("src/cart.ts")], tests: "none", flags: [{ level: "warn", text: "Changed code and ran no tests" }] });
  assert.deepEqual(once.reasons, ["Tests not run"]);
});

test("risk: riskiest first, newest first among equals, the score capped at 100", () => {
  const everything = riskOf({ files: [f("src/billing/auth.ts", 2000, 0)], tests: "fail", checks: "failing", findings: [{ severity: "high", title: "x", detail: "" }] });
  assert.equal(everything.score, 100);
  const cards = [
    { id: "small", at: 3, risk: riskOf({ files: [f("src/a.ts")], tests: "pass" }) },
    { id: "billing", at: 1, risk: riskOf({ files: [f("src/billing.ts")], tests: "pass" }) },
    { id: "none", at: 9 },
    { id: "small-newer", at: 5, risk: riskOf({ files: [f("src/b.ts")], tests: "pass" }) },
  ];
  assert.deepEqual([...cards].sort(byRisk).map((c) => c.id), ["billing", "small-newer", "small", "none"]);
});

// ── read from a session's log ───────────────────────────────────────

let seq = 0;
const ev = (body: EventBody, ts = 1000 + seq): SessionEvent => ({ seq: ++seq, ts, actor: { id: "x", name: "X", kind: "agent" } as SessionEvent["actor"], body });
const diff = (path: string, additions = 10) => ev({ type: "agent.diff", base: "abc", files: [{ path, status: "modified", additions, deletions: 0, patch: `+${"x\n+".repeat(additions)}` }] });
const ran = (id: string, command: string, ok: boolean) => [
  ev({ type: "agent.message", text: "", toolCalls: [{ id, name: "run_command", arguments: JSON.stringify({ command }) }] } as EventBody),
  ev({ type: "tool.result", callId: id, name: "run_command", output: `$ ${command}\n${ok ? "ok" : "1 failing"}`, isError: !ok }),
];

test("risk on the board: the work a pull request carries, its tests, its review, and its checks", () => {
  const log = [
    ev({ type: "run.started" } as EventBody),
    diff("src/billing/charge.ts"),
    ...ran("c1", "npm test", true),
    ev({ type: "run.ended", outcome: "done" }),
    ev({ type: "review.done", runSeq: 4, round: 1, findings: [{ severity: "medium", title: "Refund rounds down", detail: "" }], sent: false }),
    ev({ type: "folder.committed", sha: "1", branch: "charge", message: "m", files: 1, pushed: true, prUrl: "https://github.com/a/b/pull/7" }),
  ];
  const facts = reviewFacts(log, false)!;
  assert.deepEqual(facts.files, [{ path: "src/billing/charge.ts", additions: 10, deletions: 0 }]);
  assert.equal(facts.tests, "pass");
  assert.equal(facts.findings?.[0]?.title, "Refund rounds down");

  const card = boardCards({ ...initialState("s1"), title: "Charge" }, log, "me")[0]!;
  assert.equal(card.column, "review");
  assert.deepEqual(card.risk?.reasons, ["Touches billing", "Reviewer: Refund rounds down"]);
  // Projected, the run's last diff is still the lane's after the commit took it: the card still scores the committed work.
  const projected = boardCards({ ...project("s1", log), title: "Charge" }, log, "me")[0]!;
  assert.deepEqual(projected.risk?.reasons, card.risk?.reasons);
  const red = applyPrStatus(card, { state: "open", draft: false, review: "none", checks: "failing", mergeable: true, source: "github" });
  assert.equal(red.risk?.reasons.includes("Checks failing"), true, "GitHub's checks count once it has said");

  // The next piece of work starts after that commit: its own files, nothing carried over.
  const next = [...log, diff("README.md", 2)];
  assert.deepEqual(reviewFacts(next, true)!.files?.map((x) => x.path), ["README.md"]);
  assert.equal(reviewFacts([ev({ type: "run.started" } as EventBody)], true), null, "nothing changed, nothing to score");
});

test("risk on the board: In review and Ready go riskiest first; the other columns keep their order", () => {
  const card = (id: string, column: BoardCard["column"], at: number, score?: number): BoardCard =>
    ({ id, column, at, you: false, ...(score === undefined ? {} : { risk: { score, level: "low", reasons: [], top: "", quick: true } }) }) as BoardCard;
  const sorted = sortCards([card("r-safe", "review", 9, 5), card("r-risky", "review", 1, 60), card("w-old", "working", 1, 90), card("w-new", "working", 5, 0), card("ready", "ready", 2, 10)]);
  assert.deepEqual(sorted.map((c) => c.id), ["w-new", "w-old", "r-risky", "r-safe", "ready"]);
});

test("risk of a pull request: GitHub's files, lines and checks, with its session's tests and your agents' findings", () => {
  const pr = { files: [f("src/cart.ts", 8, 2)], additions: 8, deletions: 2, changedFiles: 1, checks: "passing" as const };
  assert.equal(riskOfPr(pr).quick, true, "nobody's session: nothing known against it");
  assert.equal(riskOfPr(pr, { tests: "none" }).top, "Tests not run", "made by an agent that never ran the tests");
  assert.equal(riskOfPr(pr, undefined, [{ severity: "high", title: "Drops the discount", detail: "" }]).top, "Reviewer: Drops the discount");
  assert.equal(riskOfPr({ ...pr, files: undefined, additions: 1500, deletions: 0 }).top, "1,500 lines", "GitHub's totals count when it lists no files");
});
