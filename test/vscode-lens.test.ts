import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { actionText } from "../src/client/ide/action-text.js";
import { askFromVscode } from "../src/client/ide/vscode-util.js";
import { FRIDAY_SKIN_CSS, FRIDAY_SKIN_JS } from "../src/runner/vscode-skin.js";

const require = createRequire(import.meta.url);
const lens = require(path.resolve(import.meta.dirname, "..", "src", "vscode-ext", "friday", "lens.js"));

const K = { Function: 11, Method: 5, Constructor: 8, Class: 4, Variable: 12 };
const r = (a: number, b: number) => ({ start: { line: a, character: 0 }, end: { line: b, character: 1 } });
const sym = (name: string, kind: number, a: number, b: number, children: unknown[] = []) => ({ name, kind, range: r(a, b), selectionRange: r(a, a), children });

test("pickSymbols takes functions, methods and classes with their methods, not callbacks or variables", () => {
  const picked = lens.pickSymbols(
    { SymbolKind: K },
    [sym("partialRefund", K.Function, 15, 18), sym("limit", K.Variable, 1, 1), sym("<function>", K.Function, 3, 4), sym("items.map() callback", K.Function, 5, 6), sym("authCallback", K.Function, 7, 8), sym("Ledger", K.Class, 20, 40, [sym("refund(charge)", K.Method, 22, 30), sym("x", K.Variable, 31, 31)])],
  );
  assert.deepEqual(picked.map((s: { name: string; kind: string }) => `${s.kind}:${s.name}`), ["function:partialRefund", "function:authCallback", "class:Ledger", "method:refund"]);
});

test("pickSymbols caps a file and reads the older flat symbol shape", () => {
  const many = Array.from({ length: 100 }, (_, i) => sym(`f${i}`, K.Function, i * 3, i * 3 + 2));
  assert.equal(lens.pickSymbols({ SymbolKind: K }, many).length, 40);
  const flat = lens.pickSymbols({ SymbolKind: K }, [{ name: "old", kind: K.Function, location: { range: r(1, 3) } }]);
  assert.equal(flat[0].name, "old");
});

test("the provider gives four lenses per symbol, none when the setting is off", async () => {
  let enabled = true;
  const subs: unknown[] = [];
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  let provider: { provideCodeLenses: (d: unknown) => Promise<{ command: { title: string; arguments: unknown[] } }[]> } | null = null;
  const posted: Record<string, unknown>[] = [];
  const uri = { fsPath: "/p/src/refunds.ts", toString: () => "file:///p/src/refunds.ts" };
  const doc = { uri, lineCount: 30, getText: () => "function partialRefund() {}" };
  const vscode = {
    SymbolKind: K,
    Range: class { constructor(public start: unknown, public end: unknown) {} },
    CodeLens: class { constructor(public range: unknown, public command: { title: string; arguments: unknown[] }) {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    languages: { registerCodeLensProvider: (_s: unknown, p: typeof provider) => ((provider = p), { dispose() {} }) },
    commands: { executeCommand: async () => [sym("partialRefund", K.Function, 15, 18)], registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => ((handlers[id] = fn), { dispose() {} }) },
    workspace: { getConfiguration: () => ({ get: (_k: string, d: boolean) => (enabled ? d : false) }), textDocuments: [doc], onDidChangeTextDocument: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  };
  lens.register(vscode, { subscriptions: subs }, async (b: Record<string, unknown>) => (posted.push(b), true), () => "/p");
  const lenses = await provider!.provideCodeLenses(doc);
  assert.deepEqual(lenses.map((l) => l.command.title), ["✳ Explain", "Test", "Fix", "Refactor"]);
  await handlers["friday.lensAction"](...lenses[1].command.arguments);
  assert.deepEqual(posted[0], { kind: "test", path: "/p/src/refunds.ts", from: 16, to: 19, text: "function partialRefund() {}", root: "/p", symbol: "partialRefund", symbolKind: "function" });
  enabled = false;
  assert.deepEqual(await provider!.provideCodeLenses(doc), []);
});

test("the page takes a lens ask as a chat named for the action and the function", () => {
  const a = askFromVscode("/p", { path: "/p/src/refunds.ts", from: 16, to: 19, text: "code", root: "/p", kind: "test", problem: "", symbol: "partialRefund", symbolKind: "function" }, 1);
  assert.equal(a?.symbol, "partialRefund");
  const text = actionText(a!);
  assert.match(text, /^Test partialRefund\n/);
  assert.match(text, /nearest existing test file/);
  assert.match(text, /src\/refunds.ts:16–19/);
  assert.match(actionText({ ...a!, kind: "explain" }), /^Explain partialRefund\n[\s\S]*Don't change anything/);
  assert.match(actionText({ ...a!, kind: "fix" }), /^Fix partialRefund\n[\s\S]*add a test/);
  assert.match(actionText({ ...a!, kind: "refactor" }), /^Refactor partialRefund\n[\s\S]*without changing what it does/);
});

test("the skin styles a merge conflict by class, not by link count, and tags both rows", () => {
  assert.ok(!FRIDAY_SKIN_CSS.includes("nth-of-type(4))"));
  assert.ok(FRIDAY_SKIN_CSS.includes(".codelens-decoration.fr-conflict"));
  assert.ok(FRIDAY_SKIN_CSS.includes(".codelens-decoration.fr-lens"));
  assert.ok(FRIDAY_SKIN_JS.includes('"fr-conflict"') && FRIDAY_SKIN_JS.includes('"fr-lens"'));
});
