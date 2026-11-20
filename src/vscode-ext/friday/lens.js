"use strict";
// Actions above functions (Arun, 2026-11-19: "Inline actions above functions: Explain · Test · Fix · Refactor, one click with the
// code attached."): a CodeLens row over each function, method and class, each link an ask to Friday with the symbol's code in it.
// Plain CommonJS; the vscode API is passed in so a test can hand it a stand-in.

const ACTIONS = [
  { kind: "explain", title: "✳ Explain", tip: "Explain this with Friday, changing nothing" },
  { kind: "test", title: "Test", tip: "Write and run tests for this with Friday" },
  { kind: "fix", title: "Fix", tip: "Find and fix bugs in this with Friday" },
  { kind: "refactor", title: "Refactor", tip: "Make this clearer with Friday, same behaviour" },
];
/** A file with more symbols than this gets rows over the first of them only: the row is for reading code, not for a generated file. */
const MAX_SYMBOLS = 40;
const HARD_MAX = 400;
const MAX_LINES = 6000;
const MAX_TEXT = 20000;

/** The symbols worth a row, outermost first: functions, methods and constructors, and classes with their methods inside.
 *  `keep` (optional) names symbols that are shown even past the cap: coverage's, so a long file's later functions have their rows. */
function pickSymbols(vscode, symbols, keep) {
  const K = vscode.SymbolKind || {};
  const callable = new Set([K.Function, K.Method, K.Constructor].filter((k) => k !== undefined));
  const out = [];
  const walk = (list, inClass) => {
    for (const s of list || []) {
      if (out.length >= HARD_MAX) return;
      // DocumentSymbol has .range; the older SymbolInformation has .location.range.
      const range = s.range || (s.location && s.location.range);
      if (!range || !s.name) continue;
      // An unnamed callback ("<function>", "foo.map() callback") is not a thing to ask about.
      if (/^<| callback$/.test(s.name)) continue;
      const isClass = s.kind === K.Class;
      if (callable.has(s.kind) || isClass) out.push({ name: s.name.replace(/\(.*$/, ""), kind: isClass ? "class" : s.kind === K.Method || inClass ? "method" : "function", range, selection: s.selectionRange || range });
      if (isClass) walk(s.children, true);
    }
  };
  walk(symbols, false);
  let n = 0;
  return out.filter((s) => (keep && keep(s)) || ++n <= MAX_SYMBOLS);
}

/** Returns { hooks, refresh }: hooks.test(document, symbol) may give the Test link another title and command (coverage's count),
 *  hooks.keep(document, symbol) keeps a symbol past the cap; refresh() asks the editor for the rows again. */
function register(vscode, context, postAsk, rootOf) {
  const api = { hooks: {}, refresh() {} };
  if (!vscode.languages || !vscode.languages.registerCodeLensProvider || !vscode.CodeLens || !vscode.EventEmitter) return api;
  const changed = new vscode.EventEmitter();
  const retried = new Set();
  const on = () => vscode.workspace.getConfiguration("friday").get("functionActions", true) !== false;

  const provider = {
    onDidChangeCodeLenses: changed.event,
    async provideCodeLenses(document, token) {
      if (!on() || document.lineCount > MAX_LINES) return [];
      let symbols;
      try {
        symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
      } catch {
        return [];
      }
      if (token && token.isCancellationRequested) return [];
      // A language's symbol provider can register seconds after the window loads (language extensions): nothing back yet means
      // ask again twice, later, once per file.
      if ((!symbols || !symbols.length) && !retried.has(document.uri.toString())) {
        retried.add(document.uri.toString());
        for (const ms of [1500, 5000]) setTimeout(() => changed.fire(), ms);
      }
      const lenses = [];
      for (const s of pickSymbols(vscode, symbols, api.hooks.keep && ((x) => api.hooks.keep(document, x)))) {
        // The row sits on the line the name is on (a decorator or comment above is not where the code starts).
        const at = new vscode.Range(s.selection.start, s.selection.start);
        for (const a of ACTIONS) {
          // Test carries the uncovered-lines count when the coverage view has one for this function: one row, four links.
          const o = a.kind === "test" && api.hooks.test ? api.hooks.test(document, s) : null;
          if (o) {
            lenses.push(new vscode.CodeLens(at, { command: o.command, title: o.title, tooltip: o.tooltip, arguments: o.arguments }));
            continue;
          }
          lenses.push(new vscode.CodeLens(at, { command: "friday.lensAction", title: a.title, tooltip: a.tip, arguments: [a.kind, document.uri, s.name, s.kind, s.range] }));
        }
      }
      return lenses;
    },
  };

  // One registration for both schemes: a file of this computer can answer to either (code-server serves it as a remote), and
  // a provider registered once per scheme gave every row twice.
  context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "vscode-remote" }], provider));
  context.subscriptions.push(changed);
  api.refresh = () => changed.fire();
  // Rows follow the code on their own (the editor re-asks a provider when the shown file changes); only the switch needs a fire.
  // A fire per edit of any document rebuilt every visible row and re-ran the symbol request while an agent streamed edits.
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("friday.functionActions") && changed.fire()));

  let last = { key: "", at: 0 };
  context.subscriptions.push(
    vscode.commands.registerCommand("friday.lensAction", (kind, uri, name, symbolKind, range) => {
      // A double-click would start two agents on the same function: a repeat within a moment is the same click.
      const key = `${kind}|${uri.toString()}|${name}`;
      if (key === last.key && Date.now() - last.at < 1500) return;
      last = { key, at: Date.now() };
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const text = doc ? doc.getText(range).slice(0, MAX_TEXT) : "";
      return postAsk(lensAsk(kind, uri, name, symbolKind, range, text, rootOf(uri)));
    }),
  );
  return api;
}

/** The ask a row sends: what to do, which symbol, where it is, and its code. */
function lensAsk(kind, uri, name, symbolKind, range, text, root) {
  return { kind, path: uri.fsPath, from: range.start.line + 1, to: range.end.line + 1, text, root, symbol: name, symbolKind };
}

module.exports = { register, pickSymbols, lensAsk, ACTIONS };
