import assert from "node:assert/strict";
import { test } from "node:test";
import { reachForMessage } from "../src/client/smartReach.js";
import { doneLine, doneSummary, GO_AHEAD_ASK, isGoAhead, parseDone, parsePlan, planCounts, PLAN_FENCE, refactorAsk, REFACTOR_STARTER, REVISE_LEAD, splitPath } from "../src/client/refactor-plan.js";

test("a plan is read, with bad parts made safe", () => {
  const p = parsePlan(JSON.stringify({
    summary: "  Rename PaymentIntent\nto Charge ",
    files: [
      { path: "./src\\a.ts", change: "rename the class" },
      { path: "src/b.ts" },
      "src/c.ts",
      { path: "src/a.ts", change: "and its export" },
      { path: "src/a.ts", change: "rename the class" },
      { path: "", change: "no path" },
      { change: "no path either" },
      7,
      null,
    ],
    risks: ["webhook payload", "", 4, "webhook payload", "legacy imports"],
    checks: ["npm test", { command: "npx tsc --noEmit" }, { name: "lint" }, {}, "npm test"],
  }))!;
  assert.equal(p.summary, "Rename PaymentIntent to Charge");
  // Slashes forward, no "./", a file named twice is one row with its changes together, and a bare path is a row.
  assert.deepEqual(p.files.map((f) => f.path), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(p.files[0]!.change, "rename the class; and its export");
  assert.equal(p.files[1]!.change, "");
  assert.deepEqual(p.risks, ["webhook payload", "legacy imports"]);
  assert.deepEqual(p.checks, ["npm test", "npx tsc --noEmit", "lint"]);
  assert.equal(planCounts(p), "3 files · 2 risks");
});

test("a block that is not a plan is not one", () => {
  assert.equal(parsePlan("not json"), null);
  assert.equal(parsePlan("[]"), null);
  assert.equal(parsePlan("{}"), null);
  assert.equal(parsePlan(JSON.stringify({ files: [] })), null);
  assert.equal(parsePlan(JSON.stringify({ files: [{ change: "x" }] })), null);
  // Only files is needed: the rest is optional.
  const p = parsePlan(JSON.stringify({ files: [{ path: "a.ts", change: "x" }] }))!;
  assert.deepEqual([p.summary, p.risks, p.checks], ["", [], []]);
  assert.equal(planCounts(p), "1 file");
});

test("a long plan is capped", () => {
  const files = Array.from({ length: 500 }, (_, i) => ({ path: `f${i}.ts`, change: "x".repeat(1000) }));
  const p = parsePlan(JSON.stringify({ files }))!;
  assert.equal(p.files.length, 300);
  assert.equal(p.files[0]!.change.length, 400);
});

test("the closing line is read and said", () => {
  assert.deepEqual(parseDone(JSON.stringify({ files: 6, checks: "passed", note: "look at the legacy imports" })), { files: 6, checks: "passed", note: "look at the legacy imports" });
  assert.equal(parseDone(JSON.stringify({ files: "3", checks: "FAILED" }))!.checks, "failed");
  assert.equal(parseDone(JSON.stringify({ files: 2, checks: "whatever" }))!.checks, "none");
  assert.equal(parseDone(JSON.stringify({ checks: "passed" })), null);
  assert.equal(parseDone(JSON.stringify({ files: -1 })), null);
  assert.equal(parseDone("x"), null);
  assert.equal(doneLine({ files: 6, checks: "passed", note: "" }), "Done: 6 files, checks passed");
  assert.equal(doneLine({ files: 1, checks: "failed", note: "" }), "Done: 1 file, checks failed");
  assert.equal(doneLine({ files: 0, checks: "none", note: "" }), "Done: 0 files, no checks run");
});

test("the closing line is read loosely, and failure wins", () => {
  // A list of files is its length; the checks are read from words, booleans and counts, never "none" when they failed.
  assert.equal(parseDone(JSON.stringify({ files: ["a", "b"], checks: "passed" }))!.files, 2);
  const checks = (c: unknown) => parseDone(JSON.stringify({ files: 1, checks: c }))!.checks;
  assert.equal(checks("all passed"), "passed");
  assert.equal(checks(true), "passed");
  assert.equal(checks(false), "failed");
  assert.equal(checks("2 failed, 10 passed"), "failed");
  assert.equal(checks("tsc ok, tests green"), "passed");
  assert.equal(checks("did not pass"), "failed");
  assert.equal(checks("passed, 0 failed"), "passed");
  assert.equal(checks("none"), "none");
  assert.equal(checks("not run"), "none");
  assert.equal(checks(undefined), "none");
  assert.equal(parseDone(JSON.stringify({ files: "", checks: "passed" })), null);
});

test("the closing line says Friday's own count, and the checks only as fact when Friday saw them", () => {
  const d = { files: 6, checks: "passed" as const, note: "" };
  // Nothing Friday knows (no run around it): the agent's line as it said it.
  assert.deepEqual(doneSummary(d), { title: "Done: 6 files, checks passed", claim: "" });
  // Friday's count of changed files wins, and tests it saw pass are said as fact.
  assert.deepEqual(doneSummary(d, { files: 4, tests: "pass" }), { title: "Done: 4 files, checks passed", claim: "" });
  // Tests Friday saw fail win over the agent's "passed".
  assert.equal(doneSummary(d, { files: 4, tests: "fail" }).title, "Done: 4 files, checks failed");
  // None seen: the checks are its claim underneath, not on the line (which sits beside "Done · unverified").
  const u = doneSummary(d, { files: 1, tests: null });
  assert.equal(u.title, "Done: 1 file");
  assert.match(u.claim, /says its checks passed/);
  assert.match(doneSummary({ ...d, checks: "failed" }, { files: 1, tests: null }).claim, /says its checks failed/);
  assert.equal(doneSummary({ ...d, checks: "none" }, { files: 1, tests: null }).claim, "No checks run");
  // The run still going: no claim yet, since Friday may yet see them pass.
  assert.deepEqual(doneSummary(d, { files: null, tests: null, pending: true }), { title: "Done: 6 files", claim: "" });
  // Friday saw no changed files: the agent's count stands.
  assert.equal(doneSummary(d, { files: 0, tests: null }).title, "Done: 6 files");
});

test("a revision reads as hands-off, so the agent stays in Plan until the plan is approved", () => {
  for (const change of ["add the legacy imports too", "also include the docs folder", "also rename the fixtures", "leave out src/api", "move it to lib/ instead", ""]) {
    assert.equal(reachForMessage(REVISE_LEAD + change)?.mode, "plan", change);
  }
  // On their own the typical revisions would not: that is the hole the lead-in closes.
  assert.notEqual(reachForMessage("add the legacy imports too")?.mode, "plan");
  assert.equal(reachForMessage("also include the docs folder"), null);
  assert.ok(REVISE_LEAD.includes(PLAN_FENCE));
});

test("the ask says to write the plan in the reply, not in a plan tool, and has one full stop", () => {
  assert.match(refactorAsk("rename x to y"), /ExitPlanMode/);
  assert.match(REFACTOR_STARTER, /ExitPlanMode/);
  assert.ok(refactorAsk("Rename the API.").includes("What to change: Rename the API.\n"));
  assert.ok(refactorAsk("Rename the API...").includes("What to change: Rename the API.\n"));
  assert.ok(isGoAhead(GO_AHEAD_ASK));
  assert.ok(!isGoAhead(refactorAsk("x")));
});

test("a plan path shows from the chat's root, and a long absolute folder is cut", () => {
  assert.deepEqual(splitPath("src/a/b.ts"), { name: "b.ts", dir: "src/a" });
  assert.deepEqual(splitPath("README.md"), { name: "README.md", dir: "" });
  assert.deepEqual(splitPath("/Users/me/code/app/src/a.ts", "/Users/me/code/app"), { name: "a.ts", dir: "src" });
  assert.deepEqual(splitPath("/Users/me/code/app/a.ts", "/Users/me/code/app/"), { name: "a.ts", dir: "" });
  assert.deepEqual(splitPath("/Users/me/code/other/src/a.ts", "/Users/me/code/app"), { name: "a.ts", dir: "…/other/src" });
  assert.deepEqual(splitPath("C:/Users/me/app/src/a.ts", "c:/users/me/app"), { name: "a.ts", dir: "src" });
  assert.deepEqual(splitPath("C:/Users/me/x/y/z.ts"), { name: "z.ts", dir: "…/x/y" });
});

test("the plan ask reads in Plan, and Go ahead reads as work, never Plan", () => {
  // The first asks for a plan and says to change nothing: the agent is held to reading until the plan is approved.
  for (const text of [refactorAsk("rename PaymentIntent to Charge"), refactorAsk("", "fetchUser"), REFACTOR_STARTER + "move utils/date into lib/"]) {
    assert.equal(reachForMessage(text)?.mode, "plan", text);
  }
  // "Go ahead" takes it out of Plan: "don't commit" would have read as hands-off (smartReach HANDS_OFF) and kept it in.
  const go = reachForMessage(GO_AHEAD_ASK);
  assert.ok(go && go.mode !== "plan", JSON.stringify(go));
});

test("the plan ask names the fence, the symbol and a first line for the tab", () => {
  const a = refactorAsk("make fetchUser return a Result", "fetchUser");
  assert.ok(a.startsWith("Refactor: make fetchUser return a Result\n"));
  assert.ok(a.includes("```" + PLAN_FENCE));
  // A symbol the sentence already names is not said twice.
  assert.ok(!a.includes("It starts from"));
  assert.ok(refactorAsk("rename the thing", "fetchUser").includes("It starts from `fetchUser`."));
  assert.ok(refactorAsk("x".repeat(100)).split("\n")[0]!.length < 60);
});

// The IDE's command: the symbol under the cursor starts the box; what is said is sent as a "restructure" ask.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const refactorJs = require(path.join(import.meta.dirname, "..", "src", "vscode-ext", "friday", "refactor.js"));

function fake(word: string, typed: string | undefined, scheme = "file") {
  const handlers: Record<string, (x?: string) => Promise<unknown>> = {};
  const box: { value?: string }[] = [];
  const vscode = {
    commands: { registerCommand: (id: string, fn: (x?: string) => Promise<unknown>) => ((handlers[id] = fn), { dispose() {} }) },
    workspace: { workspaceFolders: [{ uri: { fsPath: "/w" } }] },
    window: {
      activeTextEditor: {
        document: { uri: { fsPath: "/w/src/a.ts", scheme }, getText: () => word, getWordRangeAtPosition: () => (word ? {} : undefined) },
        selection: { isEmpty: true, isSingleLine: true, active: { line: 6 } },
      },
      showInputBox: async (o: { value?: string }) => (box.push(o), typed),
    },
  };
  return { handlers, box, vscode };
}

test("Friday: Refactor across the codebase sends a restructure ask with the symbol", async () => {
  const sent: Record<string, unknown>[] = [];
  const f = fake("PaymentIntent", "Rename PaymentIntent to Charge");
  refactorJs.register(f.vscode, { subscriptions: [] }, async (b: Record<string, unknown>) => void sent.push(b), () => "/w");
  await f.handlers["friday.refactorAcross"]!();
  assert.equal(f.box[0]!.value, "Rename PaymentIntent to ");
  assert.deepEqual(sent[0], { kind: "restructure", path: "/w/src/a.ts", from: 7, to: 7, text: "", root: "/w", problem: "Rename PaymentIntent to Charge", source: "the IDE", symbol: "PaymentIntent", symbolKind: "" });
});

test("nothing is sent when the box is dismissed or left as offered, and a given change skips the box", async () => {
  const sent: Record<string, unknown>[] = [];
  for (const typed of [undefined, "", "Rename PaymentIntent to "]) {
    const f = fake("PaymentIntent", typed);
    refactorJs.register(f.vscode, { subscriptions: [] }, async (b: Record<string, unknown>) => void sent.push(b), () => "/w");
    await f.handlers["friday.refactorAcross"]!();
  }
  assert.equal(sent.length, 0);
  const f = fake("", undefined);
  refactorJs.register(f.vscode, { subscriptions: [] }, async (b: Record<string, unknown>) => void sent.push(b), () => "/w");
  await f.handlers["friday.refactorAcross"]!("move utils/date into lib/");
  assert.equal(f.box.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.problem, "move utils/date into lib/");
  assert.equal("symbol" in sent[0]!, false);
});

test("a view that is not a file on disk sends no path", async () => {
  for (const scheme of ["git", "output", "untitled", "vscode-userdata"]) {
    const sent: Record<string, unknown>[] = [];
    const f = fake("PaymentIntent", "Rename PaymentIntent to Charge", scheme);
    refactorJs.register(f.vscode, { subscriptions: [] }, async (b: Record<string, unknown>) => void sent.push(b), () => "/w");
    await f.handlers["friday.refactorAcross"]!();
    assert.equal(sent[0]!.path, "", scheme);
    assert.equal(sent[0]!.root, "/w", scheme);
  }
});
