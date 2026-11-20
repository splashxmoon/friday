import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { coverText } from "../src/client/ide/cover-text.js";
import { askFromVscode } from "../src/client/ide/vscode-util.js";
import { reachForMessage } from "../src/client/smartReach.js";

const require = createRequire(import.meta.url);
const dir = path.resolve(import.meta.dirname, "..", "src", "vscode-ext", "friday");
const parse = require(path.join(dir, "cover-parse.js"));
const cover = require(path.join(dir, "cover.js"));
const lens = require(path.join(dir, "lens.js"));
const pkg = require(path.join(dir, "package.json"));

const root = path.resolve("/p");
const at = (...a: string[]) => path.join(root, ...a);
const lines = (f: { lines: Map<number, number> }) => [...f.lines].map(([n, h]) => `${n}:${h}`).join(" ");

test("lcov: lines per file, relative and absolute names, the same line twice is covered if either ran", () => {
  const files = parse.parseLcov("TN:\nSF:src/a.ts\nDA:1,3\nDA:2,0\nDA:3,0,abc\nLF:3\nLH:1\nend_of_record\nSF:" + at("src", "b.ts") + "\nDA:5,0\nDA:5,2\nend_of_record\n", root);
  assert.equal(lines(files.get(parse.fileKey(at("src", "a.ts")))), "1:3 2:0 3:0");
  assert.equal(lines(files.get(parse.fileKey(at("src", "b.ts")))), "5:2");
  assert.deepEqual(parse.uncoveredLines(files.get(parse.fileKey(at("src", "a.ts")))), [2, 3]);
});

test("lcov with windows line endings and a drive letter path", () => {
  const files = parse.parseLcov("SF:C:\\work\\x\\a.ts\r\nDA:1,0\r\nDA:2,1\r\nend_of_record\r\n", root);
  const f = files.get(parse.fileKey("C:\\work\\x\\a.ts"));
  assert.ok(f, "found by its lower-cased drive key");
  assert.deepEqual(parse.uncoveredLines(f), [1]);
});

test("istanbul: a statement's first line is covered when it ran", () => {
  const json = JSON.stringify({
    [at("src", "a.js")]: { path: at("src", "a.js"), statementMap: { 0: { start: { line: 1 }, end: { line: 1 } }, 1: { start: { line: 4 }, end: { line: 6 } }, 2: { start: { line: 4 }, end: { line: 4 } } }, s: { 0: 1, 1: 0, 2: 2 } },
    "bad.js": { nothing: true },
  });
  const files = parse.parseIstanbul(json, root);
  assert.equal(files.size, 1);
  assert.equal(lines(files.get(parse.fileKey(at("src", "a.js")))), "1:1 4:2");
  assert.equal(parse.parseIstanbul("{ not json", root).size, 0);
});

test("cobertura: classes with their lines, names from the source folders", () => {
  const xml = `<?xml version="1.0"?><coverage><sources><source>${at("pkg")}</source></sources><packages><package><classes>
    <class name="a" filename="a.py" line-rate="0.5"><methods><method name="f"><lines><line number="2" hits="1"/></lines></method></methods><lines><line number="2" hits="1"/><line number="3" hits="0"/><line number="4" hits="0" branch="false"/></lines></class>
    <class name="empty" filename="e.py"/>
  </classes></package></packages></coverage>`;
  const files = parse.parseCobertura(xml, root);
  assert.equal(files.size, 1);
  const [f] = [...files.values()];
  assert.equal(path.basename(f.file), "a.py");
  assert.equal(lines(f), "2:1 3:0 4:0");
});

test("totals, runs and how they are said", () => {
  const files = parse.parseLcov("SF:a.ts\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,1\nDA:6,0\nend_of_record\n", root);
  assert.deepEqual(parse.totals(files.values()), { found: 5, hit: 2, pct: 40 });
  assert.deepEqual(parse.toRanges([2, 3, 6, 8, 9]), [[2, 3], [6, 6], [8, 9]]);
  assert.equal(parse.formatRanges([[2, 3], [6, 6], [8, 9]]), "2-3, 6, 8-9");
  assert.equal(parse.formatRanges([[1, 1], [3, 3], [5, 5]], 2), "1, 3, and 1 more");
  assert.deepEqual(parse.within([1, 4, 9], [[3, 5], [9, 9]]), [4, 9]);
  assert.deepEqual(parse.totals([]), { found: 0, hit: 0, pct: 100 });
});

test("a diff's changed lines: added and changed runs, not removals, not deleted files", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,0 +4,2 @@ fn
+x
+y
@@ -10 +12 @@
-old
+new
@@ -20,2 +21,0 @@
-gone
-gone
diff --git a/old.ts b/old.ts
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-a
`;
  const m = parse.parseDiffRanges(diff);
  assert.deepEqual([...m], [["src/a.ts", [[4, 5], [12, 12]]]]);
});

function repo() {
  const d = mkdtempSync(path.join(os.tmpdir(), "friday-cover-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(d, "a.ts"), "export function a() {\n  return 1;\n}\n");
  git("add", "."), git("commit", "-q", "-m", "one");
  return { d, git };
}

test("changed lines against the base: committed on a branch, edited, and untracked", async () => {
  const { d, git } = repo();
  try {
    git("checkout", "-q", "-b", "topic");
    writeFileSync(path.join(d, "a.ts"), "export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n");
    git("commit", "-qam", "two");
    writeFileSync(path.join(d, "a.ts"), "export function a() {\n  return 1;\n}\nexport function b() {\n  return 3;\n}\n");
    writeFileSync(path.join(d, "new.ts"), "x\ny\nz\n");
    const ch = await parse.changedRanges(d);
    assert.deepEqual(ch.get(parse.fileKey(path.join(d, "a.ts"))).runs, [[4, 6]]);
    assert.deepEqual(ch.get(parse.fileKey(path.join(d, "new.ts"))).runs, [[1, 3]]);
    // Set against a report: only the uncovered lines inside the changes, most lines first.
    writeFileSync(path.join(d, "lcov.info"), "SF:a.ts\nDA:1,1\nDA:2,0\nDA:4,1\nDA:5,0\nDA:6,0\nend_of_record\nSF:new.ts\nDA:1,0\nend_of_record\n");
    const cov = parse.loadCoverage(d);
    assert.equal(cov.report, "lcov.info");
    const rows = parse.uncoveredInChanges(cov, ch);
    assert.deepEqual(rows.map((r: { file: string; lines: number[] }) => [path.basename(r.file), r.lines]), [["a.ts", [5, 6]], ["new.ts", [1]]]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a folder that isn't a repository has no changes; a repo on its base branch has its working changes", async () => {
  const plain = mkdtempSync(path.join(os.tmpdir(), "friday-cover-"));
  const { d } = repo();
  try {
    assert.equal((await parse.changedRanges(plain)).size, 0);
    writeFileSync(path.join(d, "a.ts"), "export function a() {\n  return 9;\n}\n");
    assert.deepEqual([...(await parse.changedRanges(d)).values()].map((c: { runs: number[][] }) => c.runs), [[[2, 2]]]);
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
});

test("reports are found by name, the newest readable one wins, an unreadable one is skipped", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "friday-cover-"));
  try {
    assert.equal(parse.loadCoverage(d), null);
    mkdirSync(path.join(d, "coverage"));
    writeFileSync(path.join(d, "coverage", "lcov.info"), "garbage");
    writeFileSync(path.join(d, "coverage.xml"), `<coverage><packages><package><classes><class filename="a.py"><lines><line number="1" hits="0"/><line number="2" hits="1"/></lines></class></classes></package></packages></coverage>`);
    writeFileSync(path.join(d, ".coverage"), "binary");
    assert.deepEqual(parse.findReports(d).map((r: { rel: string }) => r.rel).sort(), ["coverage.xml", "coverage/lcov.info"]);
    const cov = parse.loadCoverage(d);
    assert.equal(cov.report, "coverage.xml");
    assert.equal(cov.pct, 50);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// A stand-in IDE for cover.js: only what it uses.
const K = { Function: 11, Method: 5, Constructor: 8, Class: 4 };
const r = (a: number, b: number) => ({ start: { line: a, character: 0 }, end: { line: b, character: 1 } });
const sym = (name: string, kind: number, a: number, b: number) => ({ name, kind, range: r(a, b), selectionRange: r(a, a), children: [] });

function fake(d: string, enabled: boolean, posted: Record<string, unknown>[], opts: { actions?: boolean; lens?: boolean; dirty?: boolean; messages?: string[] } = {}) {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const subs: { dispose?: () => void }[] = [];
  const file = path.join(d, "src", "refunds.ts");
  const uri = { fsPath: file, toString: () => `file://${file}` };
  const doc = { uri, lineCount: 30, isDirty: !!opts.dirty, getText: () => "function partialRefund() {}" };
  type P = { provideCodeLenses: (d: unknown) => Promise<{ command: { title: string; arguments: unknown[] } }[]> };
  const providers: P[] = [];
  const vscode = {
    SymbolKind: K,
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
    Range: class { constructor(public start: unknown, public end: unknown) {} },
    CodeLens: class { constructor(public range: unknown, public command: { title: string; arguments: unknown[] }) {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    languages: { registerCodeLensProvider: (_s: unknown, p: P) => (providers.push(p), { dispose() {} }) },
    commands: {
      executeCommand: async (id: string) => (id === "vscode.executeDocumentSymbolProvider" ? [sym("partialRefund", K.Function, 4, 9), sym("refundable", K.Function, 0, 2), sym("Ledger", K.Class, 10, 20)] : undefined),
      registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => ((handlers[id] = fn), { dispose() {} }),
    },
    window: { showInformationMessage: async (m: string) => (opts.messages?.push(m), undefined) },
    workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k === "functionActions" ? opts.actions ?? d : enabled ? true : d) }), textDocuments: [doc] },
  };
  const ask = async (b: Record<string, unknown>) => (posted.push(b), true);
  const lensApi = opts.lens ? lens.register(vscode, { subscriptions: subs }, ask, () => d) : undefined;
  const state = cover.register(vscode, { subscriptions: subs }, { lens: lensApi, postAsk: async (b: Record<string, unknown>) => (posted.push(b), true), roots: () => [d], rootOf: () => d, relative: (_r: string, f: string) => path.relative(d, f).split(path.sep).join("/") });
  return { handlers, doc, state, providers, provider: () => providers[providers.length - 1], done: () => subs.forEach((s) => s.dispose?.()) };
}

function project() {
  const d = mkdtempSync(path.join(os.tmpdir(), "friday-cover-"));
  mkdirSync(path.join(d, "src"));
  writeFileSync(path.join(d, "src", "refunds.ts"), "x\n".repeat(30));
  // The report is written after the source, as a test run writes it.
  writeFileSync(path.join(d, "lcov.info"), `SF:src/refunds.ts\nDA:1,1\nDA:2,1\nDA:6,0\nDA:7,0\nDA:8,1\nDA:9,0\nDA:15,0\nend_of_record\n`);
  return d;
}

test("the lens: a row over each function that has uncovered lines, off until friday.coverage is on", async () => {
  const d = project();
  const posted: Record<string, unknown>[] = [];
  const off = fake(d, false, posted);
  try {
    assert.deepEqual(await off.provider().provideCodeLenses(off.doc), []);
    off.done();
    const on = fake(d, true, posted);
    const lenses = await on.provider().provideCodeLenses(on.doc);
    // refundable (lines 1-3) is fully covered; the class has no row of its own; partialRefund (5-10) has three.
    assert.deepEqual(lenses.map((l) => l.command.title), ["\u2733 Test 3 uncovered lines"]);
    await on.handlers["friday.coverFunction"](...lenses[0].command.arguments);
    await on.handlers["friday.coverFunction"](...lenses[0].command.arguments);
    assert.equal(posted.length, 1, "a double click is one ask");
    assert.deepEqual(posted[0], { kind: "cover", path: path.join(d, "src", "refunds.ts"), from: 5, to: 10, text: "function partialRefund() {}", root: d, symbol: "partialRefund", symbolKind: "function", source: "3 uncovered lines: 6-7, 9" });
    on.done();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a file edited after the report gets no marks until the next report", async () => {
  const d = project();
  try {
    const on = fake(d, true, []);
    assert.equal((await on.provider().provideCodeLenses(on.doc)).length, 1);
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(d, "src", "refunds.ts"), later, later);
    assert.deepEqual(await on.provider().provideCodeLenses(on.doc), []);
    on.done();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("Run coverage and Write tests for what changed post cover asks", async () => {
  const d = project();
  const posted: Record<string, unknown>[] = [];
  try {
    const on = fake(d, true, posted);
    assert.equal(on.state.state().pct, 43);
    await on.handlers["friday.runCoverage"]();
    assert.deepEqual(posted[0], { kind: "cover", path: "", from: 1, to: 1, text: "", root: d, problem: "run", source: "Coverage was 43% (lcov.info)." });
    // Not a repository: nothing changed, so no ask.
    await on.handlers["friday.coverChanged"]();
    assert.equal(posted.length, 1);
    on.done();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("Write tests for what changed sends the files and line runs inside the diff", async () => {
  const { d, git } = repo();
  const posted: Record<string, unknown>[] = [];
  try {
    mkdirSync(path.join(d, "src"));
    git("checkout", "-q", "-b", "topic");
    writeFileSync(path.join(d, "src", "refunds.ts"), "x\n".repeat(12));
    writeFileSync(path.join(d, "lcov.info"), "SF:src/refunds.ts\nDA:1,1\nDA:2,0\nDA:3,0\nDA:5,0\nDA:12,1\nend_of_record\n");
    const on = fake(d, true, posted);
    await on.handlers["friday.coverChanged"]();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].kind, "cover");
    assert.equal(posted[0].problem, "changed");
    assert.equal(posted[0].text, "src/refunds.ts: 2-3, 5");
    assert.equal(posted[0].from, 2);
    assert.match(String(posted[0].source), /^3 changed lines in 1 file are not covered\. Coverage is 40%/);
    on.done();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the manifest names every command, the view, the setting (off) and the colour the code uses", () => {
  const ids = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
  for (const id of ["friday.showCoverage", "friday.coverChanged", "friday.runCoverage", "friday.refreshCoverage", "friday.coverFunction"]) assert.ok(ids.has(id), id);
  assert.ok(pkg.contributes.views.friday.some((v: { id: string }) => v.id === "friday.coverage"));
  assert.equal(pkg.contributes.configuration.properties["friday.coverage"].default, false);
  assert.ok(pkg.contributes.colors.some((c: { id: string }) => c.id === "friday.uncoveredLine"));
});

test("the page takes a cover ask as a chat, written for a function, the changes, or a run, each reading as a job with commands", () => {
  const fn = askFromVscode("/p", { path: "/p/src/refunds.ts", from: 5, to: 10, text: "function partialRefund() {}", root: "/p", kind: "cover", symbol: "partialRefund", symbolKind: "function", source: "3 uncovered lines: 6-7, 9" }, 1)!;
  assert.equal(fn.kind, "cover");
  const t1 = coverText(fn as never);
  assert.match(t1, /^Cover partialRefund\n/);
  assert.match(t1, /3 uncovered lines: 6-7, 9/);
  assert.match(t1, /src\/refunds\.ts:5–10/);
  assert.match(t1, /coverage command again/);
  const ch = askFromVscode("/p", { path: "/p/src/a.ts", from: 2, to: 3, text: "src/a.ts: 2-3, 5\nsrc/b.ts: 1", root: "/p", kind: "cover", problem: "changed", source: "4 changed lines in 2 files are not covered. Coverage is 40% (lcov.info)." }, 1)!;
  const t2 = coverText(ch as never);
  assert.match(t2, /^Cover what changed\n/);
  assert.match(t2, /src\/a\.ts: 2-3, 5\nsrc\/b\.ts: 1/);
  const run = askFromVscode("/p", { path: "", from: 1, to: 1, text: "", root: "/p", kind: "cover", problem: "run", source: "" }, 1)!;
  assert.ok(run, "an ask with no file still reaches the column");
  const t3 = coverText(run as never);
  assert.match(t3, /^Run coverage\n/);
  assert.match(t3, /lcov\.info/);
  // Each is a job that runs commands, so the chat is not held to Plan (which cannot run or edit anything) and not told "no changes".
  for (const t of [t1, t2, t3]) assert.notEqual(reachForMessage(t)?.mode, "plan", t.split("\n")[0]);
});

test("one row of four: with the function actions on, the Test link carries the count; off, the coverage link stands alone", async () => {
  const d = project();
  try {
    const both = fake(d, true, [], { actions: true, lens: true });
    const titles = (await both.providers[0].provideCodeLenses(both.doc)).map((l) => l.command.title);
    // partialRefund has three lines no test runs: its Test link carries the count, in one row of four, with one star (Explain's).
    // refundable is covered and the class has none, so they keep the plain Test.
    assert.deepEqual(titles.slice(0, 4), ["\u2733 Explain", "Test 3 uncovered lines", "Fix", "Refactor"]);
    assert.equal(titles.filter((t) => /uncovered/.test(t)).length, 1);
    assert.ok(titles.includes("Test"));
    // The coverage provider adds nothing of its own while the function actions are there.
    assert.deepEqual(await both.providers[1].provideCodeLenses(both.doc), []);
    both.done();
    const alone = fake(d, true, [], { actions: false, lens: true });
    assert.deepEqual(await alone.providers[0].provideCodeLenses(alone.doc), []);
    assert.deepEqual((await alone.providers[1].provideCodeLenses(alone.doc)).map((l) => l.command.title), ["\u2733 Test 3 uncovered lines"]);
    alone.done();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("no coverage row while the file has unsaved edits", async () => {
  const d = project();
  try {
    const on = fake(d, true, [], { dirty: true });
    assert.deepEqual(await on.provider().provideCodeLenses(on.doc), []);
    on.done();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a long list of symbols: the ones with lines no test runs are kept past the cap", () => {
  const many = Array.from({ length: 60 }, (_, i) => sym(`f${i}`, K.Function, i * 2, i * 2 + 1));
  const plain = lens.pickSymbols({ SymbolKind: K }, many);
  assert.equal(plain.length, 40);
  const kept = lens.pickSymbols({ SymbolKind: K }, many, (s: { name: string }) => s.name === "f55");
  assert.equal(kept.length, 41);
  assert.ok(kept.some((s: { name: string }) => s.name === "f55"));
});

test("the diff is read the same under any git config: mnemonic prefixes and a non-ASCII name", async () => {
  const { d, git } = repo();
  try {
    mkdirSync(path.join(d, "src"));
    writeFileSync(path.join(d, "src", "\u00e9.js"), "a\nb\nc\n");
    mkdirSync(path.join(d, "b"), { recursive: true });
    writeFileSync(path.join(d, "b", "x.js"), "1\n");
    git("add", "."), git("commit", "-q", "-m", "two");
    git("checkout", "-q", "-b", "topic");
    writeFileSync(path.join(d, "src", "\u00e9.js"), "a\nB\nc\n");
    writeFileSync(path.join(d, "b", "x.js"), "1\n2\n");
    for (const cfg of ["diff.mnemonicPrefix=true", "diff.noprefix=true", "core.quotepath=true", "diff.renames=copies"]) {
      git("config", ...cfg.split("="));
      const ch = await parse.changedRanges(d);
      assert.deepEqual([...ch.values()].map((c: { file: string; runs: number[][] }) => [path.relative(d, c.file).split(path.sep).join("/"), c.runs]).sort(), [["b/x.js", [[2, 2]]], ["src/\u00e9.js", [[2, 2]]]], cfg);
      git("config", "--unset", cfg.split("=")[0]);
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("Write tests for what changed does not trust the report for a file edited after it, or one it has never seen", async () => {
  const { d, git } = repo();
  const posted: Record<string, unknown>[] = [];
  const said: string[] = [];
  try {
    mkdirSync(path.join(d, "src"));
    git("checkout", "-q", "-b", "topic");
    writeFileSync(path.join(d, "src", "refunds.js"), "x\n".repeat(12));
    writeFileSync(path.join(d, "lcov.info"), "SF:src/refunds.js\nDA:1,1\nDA:2,0\nDA:12,1\nend_of_record\n");
    // The report predates two edits: refunds.js is changed again, and new.js was never in it.
    const later = new Date(Date.now() + 60_000);
    writeFileSync(path.join(d, "src", "refunds.js"), "y\n".repeat(12));
    utimesSync(path.join(d, "src", "refunds.js"), later, later);
    writeFileSync(path.join(d, "src", "new.js"), "z\n");
    writeFileSync(path.join(d, "notes.md"), "not source\n");
    const on = fake(d, true, posted, { messages: said });
    await on.handlers["friday.coverChanged"]();
    assert.deepEqual(said, [], "never told that everything is covered");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].problem, "changed");
    assert.equal(posted[0].text, "Changed since the report: src/refunds.js\nNot in the report: src/new.js");
    assert.match(String(posted[0].source), /1 file changed since the report was made; 1 source file not in the report\. Coverage is 67%/);
    const t = coverText(askFromVscode(d, { ...posted[0], root: d } as never, 1) as never);
    assert.match(t, /Run the project's coverage command first/);
    assert.match(t, /Not in the report: src\/new\.js/);
    on.done();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("only a new file the report lacks: still not 'everything is covered'; a click twice is one ask", async () => {
  const { d, git } = repo();
  const posted: Record<string, unknown>[] = [];
  const said: string[] = [];
  try {
    git("checkout", "-q", "-b", "topic");
    writeFileSync(path.join(d, "lcov.info"), "SF:a.ts\nDA:1,1\nend_of_record\n");
    writeFileSync(path.join(d, "fresh.ts"), "export const x = 1;\n");
    const on = fake(d, true, posted, { messages: said });
    await Promise.all([on.handlers["friday.coverChanged"](), on.handlers["friday.coverChanged"]()]);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].text, "Not in the report: fresh.ts");
    assert.deepEqual(said, []);
    await on.handlers["friday.runCoverage"]();
    await on.handlers["friday.runCoverage"]();
    assert.equal(posted.length, 2, "Run coverage twice is one ask");
    on.done();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the gutter bar has a colour for each theme", () => {
  const fs = require("node:fs");
  assert.match(fs.readFileSync(path.join(dir, "media", "uncovered.svg"), "utf8"), /#d9a441/);
  assert.match(fs.readFileSync(path.join(dir, "media", "uncovered-light.svg"), "utf8"), /#b7791f/);
});
