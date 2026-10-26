import assert from "node:assert/strict";
import test from "node:test";
import { alertOf, calloutOf, isNumeric, pathOf, rehypeAnswer, statusOf, stepTitle } from "../src/client/answer-format.js";

/**
 * How an agent's answer is read for the shapes it already writes. A wrong guess draws code as a file, or a sentence as a
 * warning, so each rule is tested on what it must leave alone as much as on what it must catch.
 */

test("a path in backticks is a file, with its line when it has one", () => {
  assert.deepEqual(pathOf("src/client/Activity.tsx"), { path: "src/client/Activity.tsx" });
  assert.deepEqual(pathOf("ml/tune_model.py:42"), { path: "ml/tune_model.py", line: 42 });
  assert.deepEqual(pathOf("src/x.ts:12:5"), { path: "src/x.ts", line: 12 });
  assert.deepEqual(pathOf("src/x.ts#L7-L9"), { path: "src/x.ts", line: 7 });
  assert.deepEqual(pathOf("./scripts/run.sh"), { path: "scripts/run.sh" });
  assert.deepEqual(pathOf(".github/workflows/ci.yml"), { path: ".github/workflows/ci.yml" });
  assert.deepEqual(pathOf("README.md"), { path: "README.md" });
  assert.deepEqual(pathOf("package.json"), { path: "package.json" });
  assert.deepEqual(pathOf("Dockerfile"), { path: "Dockerfile" });
  assert.deepEqual(pathOf("docs/ui-checks/UI-CHECKS.md"), { path: "docs/ui-checks/UI-CHECKS.md" });
});

test("code that only looks a bit like a path stays code", () => {
  for (const s of [
    "console.log",
    "ev.ts",
    "user.name",
    "process.env",
    "res.json()",
    "npm test",
    "origin/main",
    "src/client/",
    "src/**/*.ts",
    "https://example.com/a.js",
    "github.com/owner/repo.md",
    "/Users/me/project/x.ts",
    "C:/work/x.ts",
    "~/notes.md",
    "v1.2.3",
    "e.g.",
    "a/../b.ts",
    "--flag=value.txt",
    "std::vector",
    "x",
  ])
    assert.equal(pathOf(s), null, s);
});

test("a paragraph that starts with a label is a callout of its kind", () => {
  assert.equal(calloutOf("Note: the cache is shared"), "note");
  assert.equal(calloutOf("TL;DR — it was the cache"), "note");
  assert.equal(calloutOf("Warning: this drops the table"), "warning");
  assert.equal(calloutOf("Risk: the migration locks writes"), "warning");
  assert.equal(calloutOf("Important: run it twice"), "important");
  assert.equal(calloutOf("Tip: use --watch"), "tip");
  assert.equal(calloutOf("Success means the suite is green"), "success");
  // Mentioning the word is not starting with the label.
  assert.equal(calloutOf("A note on the cache: it is shared"), null);
  assert.equal(calloutOf("Notes are kept in the sidebar"), null);
  assert.equal(calloutOf("Warnings are printed at the end"), null);
});

test("a GitHub alert is read with its label", () => {
  assert.deepEqual(alertOf("[!NOTE]\nThe cache is shared"), { kind: "note", label: "Note", marker: "[!NOTE]\n" });
  assert.equal(alertOf("[!CAUTION] Deletes data")?.kind, "danger");
  assert.equal(alertOf("[!WARNING]")?.kind, "warning");
  assert.equal(alertOf("[!FOO] nope"), null);
  assert.equal(alertOf("Not [!NOTE]"), null);
});

test("a plan step's title is a short phrase before a dash or a colon", () => {
  assert.deepEqual(stepTitle("Read the config — then the loader"), { title: "Read the config", rest: " — then the loader" });
  assert.deepEqual(stepTitle("Tests: run them twice"), { title: "Tests:", rest: " run them twice" });
  assert.equal(stepTitle("Run the tests and check the output"), null, "no separator");
  assert.equal(stepTitle("Tests:"), null, "nothing after it");
  assert.equal(stepTitle("When the build that runs on every push to main finally passes again we can: ship"), null, "a sentence, not a title");
  assert.equal(stepTitle("Meet at 10:30 tomorrow"), null);
});

test("a figure is a figure, words are not", () => {
  for (const s of ["12", "1,204", "-3.5%", "−4.1%", "+12%", "$12.50", "184 ms", "1.2s", "3x", "0.93", "12.3 MB", "~40%", "0.81 → 0.86", "0.93 (+0.02)", "+0.8 pp"])
    assert.ok(isNumeric(s), s);
  for (const s of ["v2", "Q3 2026", "about 12", "12 files changed", "src/x.ts", "—", "", "1.2.3"]) assert.ok(!isNumeric(s), s);
});

test("a status cell is the whole cell being one status word", () => {
  assert.equal(statusOf("passed"), "good");
  assert.equal(statusOf("✅ Pass"), "good");
  assert.equal(statusOf("Failed"), "bad");
  assert.equal(statusOf("skipped"), "warn");
  assert.equal(statusOf("passed after a retry"), null);
  assert.equal(statusOf("Red"), null);
});

// A small tree builder, the shape the renderer hands the pass.
type N = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: N[] };
const el = (tagName: string, children: N[] = [], properties: Record<string, unknown> = {}): N => ({ type: "element", tagName, properties, children });
const tx = (value: string): N => ({ type: "text", value });
const cls = (n: N) => (n.properties?.className as string[] | undefined) ?? [];

test("the pass marks figure columns, titles plan steps and turns labels into callouts", () => {
  const row = (...cells: string[]) => el("tr", cells.map((c) => el("td", [tx(c)])));
  const table = el("table", [
    el("thead", [el("tr", [el("th", [tx("Model")]), el("th", [tx("Recall")]), el("th", [tx("Tests")])])]),
    el("tbody", [row("baseline", "0.81", "passed"), row("tuned", "0.86 (+0.05)", "failed"), row("next", "—", "skipped")]),
  ]);
  const plan = el("ol", [el("li", [tx("Read the config — then the loader")]), el("li", [el("strong", [tx("Already")]), tx(" titled")])]);
  const nested = el("ul", [el("li", [tx("Outer"), el("ol", [el("li", [tx("Inner: not a step")])])])]);
  const note = el("p", [tx("Warning: this drops the table")]);
  const plain = el("p", [tx("A note on the cache: it is shared")]);
  const alert = el("blockquote", [tx("\n"), el("p", [tx("[!NOTE]\nThe cache is shared")])]);
  const tree = { type: "root", children: [table, plan, nested, note, plain, alert] };
  rehypeAnswer()(tree);

  const [head, body] = table.children!;
  const headCells = head!.children![0]!.children!;
  assert.deepEqual(headCells.map(cls), [[], ["num"], []], "the figure column's header is aligned with it");
  assert.deepEqual(body!.children!.map((r) => cls(r.children![1]!)), [["num"], ["num"], ["num"]]);
  assert.deepEqual(body!.children!.map((r) => r.children![2]!.properties?.dataStatus), ["good", "bad", "warn"]);

  assert.deepEqual(cls(plan), ["steps"]);
  assert.equal(plan.children![0]!.children![0]!.tagName, "strong");
  assert.equal(plan.children![0]!.children![0]!.children![0]!.value, "Read the config");
  assert.equal(plan.children![1]!.children!.length, 2, "a step already titled is left as it is");
  const inner = nested.children![0]!.children![1]!;
  assert.deepEqual(cls(inner), [], "only a list at the top of the answer is a plan");

  assert.deepEqual(cls(note), ["callout"]);
  assert.equal(note.properties!.dataCallout, "warning");
  assert.equal(note.children![0]!.tagName, "strong", "the label is bold");
  assert.deepEqual(cls(plain), []);

  assert.equal(alert.properties!.dataCallout, "note");
  const p = alert.children![1]!;
  assert.equal(p.children![0]!.children![0]!.value, "Note:");
  assert.equal(p.children![1]!.value, " The cache is shared", "the marker is gone");
});
