import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { todoText } from "../src/client/ide/todo-text.js";
import { askFromVscode } from "../src/client/ide/vscode-util.js";

const require = createRequire(import.meta.url);
const dir = path.resolve(import.meta.dirname, "..", "src", "vscode-ext", "friday");
const parse = require(path.join(dir, "todo-parse.js"));
const todos = require(path.join(dir, "todos.js"));
const pkg = require(path.join(dir, "package.json"));

const scan = (text: string, file: string) => parse.scanText(text, file).map((h: { line: number; tag: string; who: string; text: string }) => `${h.line} ${h.tag}${h.who ? `(${h.who})` : ""} ${h.text}`);

test("slash comments, in the languages that use them", () => {
  const src = "const a = 1; // TODO: handle empty\n/* FIXME rounding */ const b = 2;\n/**\n * HACK(ann): temporary\n * more words\n */\nlet c; // not this\n";
  for (const f of ["a.ts", "a.js", "a.tsx", "a.go", "a.java", "a.rs", "a.swift", "a.c", "a.cs", "a.kt"]) {
    assert.deepEqual(scan(src, f), ["1 TODO handle empty", "2 FIXME rounding", "4 HACK(ann) temporary"], f);
  }
});

test("hash comments: Python, shell, YAML, Ruby; a hash inside a string or word is not a comment", () => {
  const src = "x = 1  # TODO(bob) tidy this\ns = \"# TODO not a comment\"\nt = 'a # FIXME no'\n# XXX: really\nname#TODO no space\n";
  for (const f of ["a.py", "a.sh", "a.yml", "a.rb", "Makefile", "Dockerfile"]) {
    assert.deepEqual(scan(src, f), ["1 TODO(bob) tidy this", "4 XXX really"], f);
  }
});

test("a Python docstring is a string, not a comment", () => {
  assert.deepEqual(scan('def f():\n    """\n    TODO: in a docstring\n    """\n    return 1  # TODO later\n', "a.py"), ["5 TODO later"]);
});

test("block comments over several lines, and markup comments", () => {
  assert.deepEqual(scan("/*\n  old stuff\n  TODO: remove after v2\n*/\ncode();\n", "a.css"), ["3 TODO remove after v2"]);
  assert.deepEqual(scan("<p>hi</p>\n<!-- TODO: add footer -->\n<!--\n  FIXME links\n-->\n", "a.html"), ["2 TODO add footer", "4 FIXME links"]);
  assert.deepEqual(scan("# TODO list heading\n\n<!-- XXX old -->\nIt's a TODO in prose.\n", "README.md"), ["3 XXX old"]);
  assert.deepEqual(scan("<template><!-- TODO: x --></template>\n<script>\n// FIXME y\n</script>\n", "a.vue"), ["1 TODO x", "3 FIXME y"]);
});

test("double-dash comments: SQL, Lua, Haskell", () => {
  assert.deepEqual(scan("select 1; -- TODO: index this\nselect '-- TODO in a string';\n", "a.sql"), ["1 TODO index this"]);
  assert.deepEqual(scan("local x = 1 -- FIXME nil case\n--[[\n TODO: block\n]]\n", "a.lua"), ["1 FIXME nil case", "3 TODO block"]);
  assert.deepEqual(scan("f = 1 -- HACK: for now\n", "a.hs"), ["1 HACK for now"]);
});

test("false positives: strings, variables, prose, links", () => {
  const src = [
    'const todos = ["TODO"];',
    'const s = "// TODO: in a string";',
    "const t = `// FIXME in a template`;",
    "const url = 'http://example.com/TODO'; // fine",
    "// todos are loaded below",
    "// the TODOS list",
    "// TODOs: not the marker",
    "// see the todo list handler",
    "function doTodo() {} // HACKING guide",
    "// fixme later",
    "const re = /x/; // x",
  ].join("\n");
  assert.deepEqual(scan(src, "a.ts"), []);
  assert.deepEqual(scan("const s = 'don\\'t'; // TODO: y\nconst u = \"it's\"; // FIXME z\n", "a.js"), ["1 TODO y", "2 FIXME z"]);
});

test("lower case counts only with a colon or a name; a marker later in a comment only as TODO:", () => {
  assert.deepEqual(scan("// todo: lower\n// Todo(ann) title\n// NOTE: TODO: remove it\n// handle the TODO case\n", "a.ts"), ["1 TODO lower", "2 TODO(ann) title", "3 TODO remove it"]);
});

test("one marker per line, text tidy, an empty marker is kept, a line of a minified file is skipped", () => {
  assert.deepEqual(scan("// TODO\nx; // TODO:   two   words  */\n", "a.ts"), ["1 TODO ", "2 TODO two words"]);
  assert.deepEqual(scan(`${"a".repeat(2500)} // TODO: huge\n// TODO: kept\n`, "a.js"), ["2 TODO kept"]);
  assert.deepEqual(scan("// TODO: a\r\n// FIXME: b\r\n", "a.ts"), ["1 TODO a", "2 FIXME b"]);
});

test("kinds of file that are not scanned", () => {
  assert.equal(parse.styleFor("bundle.min.js"), null);
  assert.equal(parse.styleFor("yarn.lock"), null);
  assert.equal(parse.styleFor("logo.png"), null);
  assert.deepEqual(scan("// TODO: x\n", "a.png"), []);
});

test("files.exclude globs", () => {
  const hide = parse.excluder({ "**/node_modules": true, "**/*.log": true, "dist": true, "**/{gen,tmp}/**": true, "keep": false });
  assert.ok(hide("node_modules/a/b.js") && hide("pkg/node_modules/x.js"));
  assert.ok(hide("a/b/c.log") && hide("dist/x.js") && hide("src/gen/a.ts") && hide("tmp/a.ts"));
  assert.ok(!hide("src/dist/x.js") && !hide("keep/a.ts") && !hide("src/a.ts"));
});

test("a folder: git's list (ignored files left out), files.exclude, per file hits sorted, blame for one line", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todos-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=ann@x.dev", "-c", "user.name=Ann", ...a], { cwd: root, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "build"));
    mkdirSync(path.join(root, "gen"));
    writeFileSync(path.join(root, ".gitignore"), "build/\n");
    writeFileSync(path.join(root, "src", "b.ts"), "export const x = 1; // TODO: b one\n");
    writeFileSync(path.join(root, "src", "a.py"), "# FIXME: a one\nx = 1\n# TODO(me) a two\n");
    writeFileSync(path.join(root, "build", "out.js"), "// TODO: built\n");
    writeFileSync(path.join(root, "gen", "g.ts"), "// TODO: generated\n");
    writeFileSync(path.join(root, "logo.png"), "// TODO: not text\n");
    git("add", ".gitignore", "src");
    git("commit", "-q", "-m", "first");
    writeFileSync(path.join(root, "src", "c.ts"), "// XXX: not committed yet\n");
    const out = await parse.scanFolder(root, { exclude: { "**/gen": true } });
    assert.deepEqual(out.map((f: { rel: string; hits: unknown[] }) => `${f.rel}:${f.hits.length}`), ["src/a.py:2", "src/b.ts:1", "src/c.ts:1"]);
    const b = await parse.blameLine(path.join(root, "src", "b.ts"), 1);
    assert.equal(b.author, "Ann");
    assert.ok(Date.now() - b.at < 60_000);
    assert.equal(await parse.blameLine(path.join(root, "src", "c.ts"), 1), null, "a line not committed has no author yet");
    // Not a git repository: a walk that skips the usual build folders.
    const plain = mkdtempSync(path.join(os.tmpdir(), "todos-plain-"));
    try {
      mkdirSync(path.join(plain, "node_modules"));
      writeFileSync(path.join(plain, "node_modules", "n.js"), "// TODO: dep\n");
      writeFileSync(path.join(plain, "m.js"), "// TODO: mine\n");
      assert.deepEqual((await parse.scanFolder(plain)).map((f: { rel: string }) => f.rel), ["m.js"]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    // The caps.
    const many = Array.from({ length: 30 }, (_, i) => `// TODO: n${i}`).join("\n");
    writeFileSync(path.join(root, "src", "many.ts"), many);
    const capped = await parse.scanFolder(root, { maxHits: 10 });
    assert.ok(capped.reduce((n: number, f: { hits: unknown[] }) => n + f.hits.length, 0) <= 10 + 4, "stops reading once it has enough");
    assert.ok(parse.ago(Date.now() - 3 * 86400_000) === "3 days ago" && parse.ago(Date.now() - 86400_000) === "1 day ago" && parse.ago(Date.now()) === "just now");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ask: the marker's words and 10 lines each side; the page's words for it", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const ask = todos.todoAsk("/p/src/a.ts", "/p", { line: 20, tag: "FIXME", text: "handle empty" }, lines.join("\n"));
  assert.deepEqual({ ...ask, text: undefined }, { kind: "todo", path: "/p/src/a.ts", from: 10, to: 30, text: undefined, root: "/p", line: 20, problem: "handle empty", source: "FIXME" });
  assert.equal(ask.text.split("\n").length, 21);
  assert.equal(todos.todoAsk("/p/a.ts", "/p", { line: 2, tag: "TODO", text: "x" }, "a\nb\nc").from, 1);
  const page = askFromVscode("/p", { ...ask, at: Date.now() }, Date.now());
  assert.equal(page?.kind, "todo");
  assert.equal(page?.path, "src/a.ts");
  const text = todoText(page as never);
  assert.match(text, /^FIXME a\.ts:20\n/);
  assert.match(text, /Do this FIXME: "handle empty"/);
  assert.match(text, /remove the FIXME comment, run the tests/);
  assert.match(text, /src\/a\.ts:10–30/);
  assert.match(todoText({ path: "a/b.ts", from: 1, to: 1, text: "", line: 3, problem: "", source: "TODO" }), /^TODO b\.ts:3\n\nDo what this TODO comment asks/);
});

test("the extension's wiring: the commands the package declares, the lens, the ask and the view", async () => {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const asked: Record<string, unknown>[] = [];
  const root = mkdtempSync(path.join(os.tmpdir(), "todos-ext-"));
  try {
    writeFileSync(path.join(root, "a.ts"), "// TODO: first\nconst x = 1;\n");
    let lens: { provideCodeLenses(d: unknown): { command: { command: string; title: string; arguments: unknown[] }; range: unknown }[] } | null = null;
    let provider: { getChildren(n?: unknown): { file?: { rel: string }; leaf?: boolean }[]; getTreeItem(n: unknown): { label: string; description?: string; contextValue: string; command?: { command: string } } } | null = null;
    class Emitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
    const vscode = {
      EventEmitter: Emitter,
      commands: { registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => ((handlers[id] = fn), { dispose() {} }), executeCommand: async () => {} },
      TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      ThemeIcon: class { constructor(public id: string) {} },
      CodeLens: class { constructor(public range: unknown, public command: never) {} },
      Range: class { constructor(public a: number, public b: number, public c: number, public d: number) {} },
      Position: class { constructor(public line: number, public character: number) {} },
      Uri: { file: (f: string) => ({ fsPath: f, scheme: "file" }) },
      languages: { registerCodeLensProvider: (_s: unknown, p: typeof lens) => ((lens = p), { dispose() {} }) },
      window: { createTreeView: (_id: string, o: { treeDataProvider: typeof provider }) => ((provider = o.treeDataProvider), { dispose() {} }), setStatusBarMessage() {} },
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }), textDocuments: [] as unknown[] },
    };
    const context = { subscriptions: [] as unknown[] };
    const api = todos.register(vscode, context, { postAsk: async (b: Record<string, unknown>) => (asked.push(b), true), roots: () => [root], rootOf: () => root });
    await api.scan();
    assert.deepEqual(api.state().map((f: { rel: string }) => f.rel), ["a.ts"]);
    for (const c of ["friday.todo.hand", "friday.todo.open", "friday.todo.refresh"]) {
      assert.ok(handlers[c], c);
      assert.ok(pkg.contributes.commands.some((x: { command: string }) => x.command === c), `${c} is declared`);
    }
    const files = provider!.getChildren();
    assert.equal(files[0].file!.rel, "a.ts");
    const rows = provider!.getChildren(files[0]);
    const row = provider!.getTreeItem(rows[0]);
    assert.equal(row.label, "1 · first");
    assert.equal(row.contextValue, "friday.todo");
    assert.equal(row.command!.command, "friday.todo.open");
    const doc = { uri: { fsPath: path.join(root, "a.ts"), scheme: "file" }, lineCount: 2, getText: () => "x();\n// FIXME(ann): unsaved one\nmore();\n" };
    const lenses = lens!.provideCodeLenses(doc);
    assert.equal(lenses.length, 1, "from the editor's own text");
    assert.equal(lenses[0].command.title, "✳ Do this");
    assert.equal((lenses[0].range as { a: number }).a, 1);
    await handlers["friday.todo.hand"](rows[0]);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].kind, "todo");
    assert.equal(asked[0].problem, "first");
    assert.equal(asked[0].line, 1);
    await handlers["friday.todo.hand"](rows[0]);
    assert.equal(asked.length, 1, "a double click is one ask");
    (vscode.workspace.textDocuments as unknown[]).push(doc);
    await handlers["friday.todo.hand"](...(lenses[0].command.arguments as unknown[]));
    assert.equal(asked.length, 2);
    assert.equal(asked[1].source, "FIXME");
    assert.ok(pkg.contributes.views.friday.some((v: { id: string }) => v.id === "friday.todos"));
    assert.ok(pkg.contributes.viewsWelcome.some((v: { view: string }) => v.view === "friday.todos"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matcher gaps: @todo tags, file names and words, regexes with quotes, runaway backticks, strings in mixed files, script in html, PowerShell", () => {
  assert.deepEqual(scan("/**\n * @todo finish this\n */\n// TODO.md is the file\n// XXX-large\n// TODO: x\n// @todolist is a word\n", "a.ts"), ["2 TODO finish this", "6 TODO x"]);
  assert.deepEqual(scan("const r = /[\"']/g; // TODO: after a regex\nconst q = /`/; // FIXME: after a backtick regex\nconst z = a / b; // HACK: division\n", "a.js"), ["1 TODO after a regex", "2 FIXME after a backtick regex", "3 HACK division"]);
  assert.deepEqual(scan(`a = \`\n${"x\n".repeat(80)}// TODO: far below a stray backtick\n`, "a.js"), ["82 TODO far below a stray backtick"]);
  assert.deepEqual(scan("const a = `x ${`y`} // TODO: inside the template`;\nok(); // TODO: after it\n", "a.js"), ["2 TODO after it"]);
  assert.deepEqual(scan("<script>\nconst s = \"// TODO: str\"; // FIXME: real\n</script>\n<!-- XXX: markup -->\n", "a.vue"), ["2 FIXME real", "4 XXX markup"]);
  assert.deepEqual(scan("<p>don't</p>\n<script>\n// TODO: in the page's script\n</script>\n", "a.html"), ["3 TODO in the page's script"]);
  assert.deepEqual(scan("<#\n TODO: in a block\n#>\n$a = 1 # FIXME: line\n$s = '# TODO no'\n", "a.ps1"), ["2 TODO in a block", "4 FIXME line"]);
});

test("a bad files.exclude key hides nothing and does not throw", () => {
  const hide = parse.excluder({ "src/{a,b": true, "**/gen": true });
  assert.ok(hide("x/gen/a.ts") && !hide("src/a.ts"));
});

test("caps are reported, and code is read before prose", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todos-cap-"));
  try {
    for (const f of ["a.md", "b.md", "c.yml", "z.ts", "y.py"]) writeFileSync(path.join(root, f), f.endsWith("py") ? "# TODO: py\n" : "// TODO: x\n# TODO: x\n");
    const out = await parse.scanFolder(root, { maxFiles: 2 });
    assert.deepEqual(out.map((f: { rel: string }) => f.rel), ["y.py", "z.ts"], "the two code files, not the notes");
    assert.deepEqual(out.capped, { files: true, hits: false });
    const all = await parse.scanFolder(root);
    assert.deepEqual(all.capped, { files: false, hits: false });
    assert.equal((await parse.scanFolder(root, { maxHits: 1 })).capped.hits, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A stand-in editor API whose tree can be read and whose watcher can be fired. */
function stand(root: string) {
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const state: { provider: { getChildren(n?: unknown): { file?: { rel: string; hits: unknown[] }; leaf?: boolean; note?: string }[]; getTreeItem(n: unknown): { label: string; description?: string } } | null; view: { badge?: unknown; description?: string } | null; fire: Record<string, (u: unknown) => void>; contexts: Record<string, unknown>; status: string[] } = { provider: null, view: null, fire: {}, contexts: {}, status: [] };
  class Emitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
  const w = { onDidChange: (f: (u: unknown) => void) => ((state.fire.change = f), { dispose() {} }), onDidCreate: (f: (u: unknown) => void) => ((state.fire.create = f), { dispose() {} }), onDidDelete: (f: (u: unknown) => void) => ((state.fire.delete = f), { dispose() {} }), dispose() {} };
  const vscode = {
    EventEmitter: Emitter,
    commands: { registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => ((handlers[id] = fn), { dispose() {} }), executeCommand: async (_c: string, k: string, v: unknown) => void (state.contexts[k] = v) },
    TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(public id: string) {} },
    Uri: { file: (f: string) => ({ fsPath: f, scheme: "file" }) },
    RelativePattern: class { constructor(public base: string, public pattern: string) {} },
    window: { createTreeView: (_id: string, o: { treeDataProvider: typeof state.provider }) => ((state.provider = o.treeDataProvider), (state.view = {}), state.view as object), setStatusBarMessage: (m: string) => void state.status.push(m) },
    workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }), textDocuments: [], createFileSystemWatcher: () => w },
  };
  const asked: Record<string, unknown>[] = [];
  const api = todos.register(vscode, { subscriptions: [] as unknown[] }, { postAsk: async (b: Record<string, unknown>) => (asked.push(b), true), roots: () => [root], rootOf: () => root });
  return { api, state, handlers, asked };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the view follows the disk: no badge, an agent's edit takes the row away, a handed row is checked against the file, authors stay, caps say so", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todos-live-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=ann@x.dev", "-c", "user.name=Ann Lee", ...a], { cwd: root, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(root, ".gitignore"), "ignored.ts\n");
    writeFileSync(path.join(root, "a.ts"), "// TODO: first\nconst x = 1;\n// FIXME: second\n");
    git("add", "."), git("commit", "-q", "-m", "one");
    const { api, state, handlers, asked } = stand(root);
    assert.equal(state.contexts["friday.todosScanned"], undefined, "not looked yet");
    await api.scan();
    assert.equal(state.contexts["friday.todosScanned"], true);
    assert.equal(state.contexts["friday.hasTodos"], true);
    assert.equal(state.view!.badge, undefined, "the TODO count is not a badge on the Friday icon");
    assert.match(state.view!.description!, /^2 in 1 file$/);
    const rowsOf = () => state.provider!.getChildren(state.provider!.getChildren()[0]);
    const authorOf = (i: number) => state.provider!.getTreeItem(rowsOf()[i]).description;
    for (let i = 0; i < 50 && authorOf(0) !== "Ann"; i++) await sleep(50);
    assert.equal(authorOf(0), "Ann");
    // Someone else (an agent) takes the first TODO out on disk: the row goes, the second moves up to line 2... and is still Ann's.
    const file = path.join(root, "a.ts");
    writeFileSync(file, "const x = 1;\n// FIXME: second\n");
    state.fire.change({ fsPath: file, scheme: "file" });
    for (let i = 0; i < 40 && rowsOf().length !== 1; i++) await sleep(50);
    assert.equal(rowsOf().length, 1, "the row of the comment that was removed is gone");
    assert.match(state.provider!.getTreeItem(rowsOf()[0]).label, /^2 · second$/);
    assert.equal(state.view!.badge, undefined);
    git("add", "."), git("commit", "-q", "-m", "two");
    // Authors stay after a change to the file (read again for it), not only after a full rescan.
    for (let i = 0; i < 60 && authorOf(0) !== "Ann"; i++) await sleep(50);
    writeFileSync(file, "const x = 1;\n// FIXME: second\n// TODO: third\n");
    state.fire.change({ fsPath: file, scheme: "file" });
    for (let i = 0; i < 40 && rowsOf().length !== 2; i++) await sleep(50);
    for (let i = 0; i < 60 && !authorOf(0); i++) await sleep(50);
    assert.equal(authorOf(0), "Ann", "the author of a row is still there after the file changed");
    // A stale row handed over: the old row said line 2, the file now has the marker on line 3.
    const stale = rowsOf()[0];
    writeFileSync(file, "// one\n// two\nconst x = 1;\n// FIXME: second\n");
    await handlers["friday.todo.hand"](stale);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].line, 4, "the line it is on now, not the line the row had");
    assert.equal(asked[0].problem, "second");
    // And a marker that is gone is not sent.
    writeFileSync(file, "// one\n");
    const gone = { leaf: true, f: { file }, h: { line: 9, tag: "TODO", text: "removed already" } };
    await handlers["friday.todo.hand"](gone);
    assert.equal(asked.length, 1, "nothing sent for a comment that is not there");
    assert.ok(state.status.some((m) => /gone/.test(m)));
    // A file git ignores, one in a build folder and a file on another root with the same prefix are not listed.
    writeFileSync(path.join(root, "ignored.ts"), "// TODO: ignored\n");
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "o.js"), "// TODO: built\n");
    for (const f of [path.join(root, "ignored.ts"), path.join(root, "dist", "o.js"), root + "-other/x.ts"]) state.fire.create({ fsPath: f, scheme: "file" });
    writeFileSync(path.join(root, "b.ts"), "// HACK: new file\n");
    state.fire.create({ fsPath: path.join(root, "b.ts"), scheme: "file" });
    for (let i = 0; i < 40 && !state.provider!.getChildren().some((n) => n.file && n.file.rel === "b.ts"); i++) await sleep(50);
    assert.deepEqual(state.provider!.getChildren().map((n) => n.file?.rel).filter(Boolean), ["b.ts"], "only the new, wanted file");
    assert.equal(api.state().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a save keeps the authors; the view says when the first look is not done, and when a cap stopped it", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todos-save-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=ann@x.dev", "-c", "user.name=Ann Lee", ...a], { cwd: root, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(root, "a.ts"), "// TODO: one\n");
    git("add", "."), git("commit", "-q", "-m", "one");
    const { api, state } = stand(root);
    await api.scan();
    const rows = () => state.provider!.getChildren(state.provider!.getChildren()[0]);
    for (let i = 0; i < 50 && state.provider!.getTreeItem(rows()[0]).description !== "Ann"; i++) await sleep(50);
    const text = "// TODO: one\nconst a = 1;\n";
    await api.rescanFile({ uri: { fsPath: path.join(root, "a.ts"), scheme: "file" }, lineCount: 3, getText: () => text });
    for (let i = 0; i < 50 && state.provider!.getTreeItem(rows()[0]).description !== "Ann"; i++) await sleep(50);
    assert.equal(state.provider!.getTreeItem(rows()[0]).description, "Ann", "after a save the row still has its author");
    // A saved file that is not wanted is not added; one in a folder with the root's name as a prefix neither.
    await api.rescanFile({ uri: { fsPath: path.join(root, "node_modules", "x.js"), scheme: "file" }, lineCount: 1, getText: () => "// TODO: dep\n" });
    await api.rescanFile({ uri: { fsPath: root + "-other/x.ts", scheme: "file" }, lineCount: 1, getText: () => "// TODO: elsewhere\n" });
    assert.equal(api.state().length, 1);
    assert.deepEqual(api.capped(), { files: false, hits: false });
    assert.equal(state.provider!.getChildren().some((n) => n.note), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the welcome text waits for the first look", () => {
  const w = pkg.contributes.viewsWelcome.filter((v: { view: string }) => v.view === "friday.todos");
  assert.ok(w.some((v: { when: string; contents: string }) => v.when === "!friday.todosScanned" && /Looking for/.test(v.contents)));
  assert.ok(w.some((v: { when: string }) => v.when === "friday.todosScanned && !friday.hasTodos"));
});
