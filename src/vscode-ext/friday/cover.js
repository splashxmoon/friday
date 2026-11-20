"use strict";
// Tests where coverage is missing (Arun, wave 2: "Test generation from coverage: Friday reads your coverage report and writes tests
// for what isn't covered, starting with what changed."): the report found in the folder (cover-parse.js), the lines it says never
// ran marked quietly in the gutter, "✳ Test 7 uncovered lines" above each function that has some, a Coverage view and a status bar
// figure, and two asks to Friday: tests for one function, or for what changed against the base ("cover" asks, written up by the
// page's cover-text.ts). All of it follows friday.coverage, off until the person turns it on ("Friday: Show coverage"); the view and
// its buttons work either way. Plain CommonJS; the vscode API is passed in so a test can hand it a stand-in.
const fs = require("node:fs");
const path = require("node:path");
const parse = require("./cover-parse.js");
const lens = require("./lens.js");

const MAX_TEXT = 20000;
const MAX_FILES = 30;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One report out of every folder open: files together, the totals added up. */
function loadAll(roots) {
  const files = new Map();
  const reports = [];
  let mtime = 0;
  for (const root of roots) {
    const c = parse.loadCoverage(root);
    if (!c) continue;
    for (const [k, f] of c.files) files.set(k, f);
    reports.push(c.report);
    mtime = Math.max(mtime, c.mtime);
  }
  if (!files.size) return null;
  return { files, report: reports.join(", "), mtime, ...parse.totals(files.values()) };
}

/** A file's edits after the report was made: its line numbers can't be trusted, so it is left unmarked until the next report. */
function stale(cov, file) {
  try {
    return fs.statSync(file).mtimeMs > cov.mtime + 1500;
  } catch {
    return true;
  }
}

function register(vscode, context, { postAsk, roots, rootOf, relative, lens: lensApi }) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const cfg = () => vscode.workspace.getConfiguration("friday");
  const on = () => cfg().get("coverage", false) === true;
  let cov = null;
  const changed = vscode.EventEmitter ? new vscode.EventEmitter() : null;
  const treeChanged = vscode.EventEmitter ? new vscode.EventEmitter() : null;
  if (changed) context.subscriptions.push(changed, treeChanged);
  const rel = (file) => (relative ? relative(rootOf(vscode.Uri.file(file)), file) : file);

  // ---- the gutter: a quiet bar by each line that never ran, and a tick in the overview ruler.
  let deco = null;
  const paint = () => {
    if (!vscode.window.createTextEditorDecorationType || !vscode.window.visibleTextEditors) return;
    if (!deco) {
      // One bar per theme, in the colours friday.uncoveredLine declares (a ThemeColor can't tint an icon file).
      const icon = (name) => vscode.Uri.file(path.join(context.extensionPath || __dirname, "media", name));
      deco = vscode.window.createTextEditorDecorationType({
        gutterIconPath: icon("uncovered.svg"),
        light: { gutterIconPath: icon("uncovered-light.svg") },
        dark: { gutterIconPath: icon("uncovered.svg") },
        gutterIconSize: "contain",
        overviewRulerColor: new vscode.ThemeColor("friday.uncoveredLine"),
        overviewRulerLane: vscode.OverviewRulerLane ? vscode.OverviewRulerLane.Left : undefined,
      });
      context.subscriptions.push(deco);
    }
    for (const ed of vscode.window.visibleTextEditors) {
      const f = on() && cov && ed.document && cov.files.get(parse.fileKey(ed.document.uri.fsPath));
      const lines = f && !stale(cov, f.file) ? parse.uncoveredLines(f).filter((n) => n <= ed.document.lineCount) : [];
      ed.setDecorations(deco, lines.map((n) => new vscode.Range(n - 1, 0, n - 1, 0)));
    }
  };

  // ---- the status bar: the overall figure, over to the Coverage view.
  let bar = null;
  const drawBar = () => {
    if (!vscode.window.createStatusBarItem) return;
    if (!cov) return bar && bar.hide();
    if (!bar) {
      bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment ? vscode.StatusBarAlignment.Left : 1, 40);
      bar.command = "friday.coverage.focus";
      context.subscriptions.push(bar);
    }
    bar.text = `$(beaker) ${cov.pct}%`;
    bar.tooltip = `Test coverage: ${cov.pct}% of ${plural(cov.found, "line", "lines")} (${cov.report}). Open the Coverage view.`;
    bar.show();
  };

  // Reading a report is the slow part (a big lcov or coverage-final.json): only when a report file changed (sig), never per save.
  let loadedSig = null;
  const repaint = () => {
    if (vscode.commands.executeCommand) void Promise.resolve(vscode.commands.executeCommand("setContext", "friday.hasCoverage", !!cov)).catch(() => {});
    paint();
    drawBar();
    if (changed) changed.fire();
    if (treeChanged) treeChanged.fire();
    if (lensApi) lensApi.refresh();
  };
  const refresh = (force) => {
    const now = sig();
    if (force || now !== loadedSig || loadedSig === null) {
      cov = loadAll(roots());
      loadedSig = now;
    }
    repaint();
  };
  let timer;
  const later = (fn) => {
    clearTimeout(timer);
    timer = setTimeout(fn, 300);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });

  // The lines of a function that no test runs, by the report: none while the file has unsaved edits (the report's numbers are
  // for the saved file) or was edited after the report.
  const uncoveredIn = (document, s) => {
    if (!on() || !cov || document.isDirty) return [];
    const f = cov.files.get(parse.fileKey(document.uri.fsPath));
    if (!f || stale(cov, f.file)) return [];
    return parse.within(parse.uncoveredLines(f), [[s.range.start.line + 1, s.range.end.line + 1]]);
  };
  const testLink = (document, s) => {
    const mine = uncoveredIn(document, s);
    return mine.length ? { title: `Test ${plural(mine.length, "uncovered line", "uncovered lines")}`, tooltip: "Write tests for the lines of this function that no test runs, with Friday", command: "friday.coverFunction", arguments: [document.uri, s.name, s.kind, s.range, mine] } : null;
  };
  // With the function actions on, the Test link of a function's row carries the count (one row of four, not a fifth link).
  if (lensApi) {
    lensApi.hooks.test = (document, s) => (s.kind === "class" ? null : testLink(document, s));
    lensApi.hooks.keep = (document, s) => s.kind !== "class" && uncoveredIn(document, s).length > 0;
  }

  // ---- the row above a function with lines that never ran, when the function actions are off (lens.js has none to carry it).
  if (vscode.languages && vscode.languages.registerCodeLensProvider && vscode.CodeLens && changed) {
    const retried = new Set();
    const alone = () => !lensApi || cfg().get("functionActions", true) === false;
    const provider = {
      onDidChangeCodeLenses: changed.event,
      async provideCodeLenses(document, token) {
        if (!on() || !cov || !alone() || document.lineCount > 6000) return [];
        const f = cov.files.get(parse.fileKey(document.uri.fsPath));
        if (!f || stale(cov, f.file) || document.isDirty || !parse.uncoveredLines(f).length) return [];
        let symbols;
        try {
          symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
        } catch {
          return [];
        }
        if (token && token.isCancellationRequested) return [];
        if ((!symbols || !symbols.length) && !retried.has(document.uri.toString())) {
          retried.add(document.uri.toString());
          for (const ms of [1500, 5000]) setTimeout(() => changed.fire(), ms);
        }
        const out = [];
        // A class is not a function: its methods carry their own rows. Functions with no lines to cover are dropped before the cap.
        for (const s of lens.pickSymbols(vscode, symbols, (x) => x.kind !== "class" && uncoveredIn(document, x).length > 0)) {
          const t = s.kind === "class" ? null : testLink(document, s);
          if (!t) continue;
          out.push(new vscode.CodeLens(new vscode.Range(s.selection.start, s.selection.start), { command: t.command, title: `\u2733 ${t.title}`, tooltip: t.tooltip, arguments: t.arguments }));
        }
        return out;
      },
    };
    context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "vscode-remote" }], provider));
  }

  // One click is one ask: a repeat of the same thing within a moment (a double click on a row or a button) is dropped.
  let last = { key: "", at: 0 };
  const repeat = (key) => {
    if (key === last.key && Date.now() - last.at < 1500) return true;
    last = { key, at: Date.now() };
    return false;
  };
  reg("friday.coverFunction", (uri, name, kind, range, lines) => {
    if (repeat(`fn|${uri.toString()}|${name}`)) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const text = doc ? doc.getText(range).slice(0, MAX_TEXT) : "";
    return postAsk({
      kind: "cover",
      path: uri.fsPath,
      from: range.start.line + 1,
      to: range.end.line + 1,
      text,
      root: rootOf(uri),
      symbol: name,
      symbolKind: kind,
      source: `${plural(lines.length, "uncovered line", "uncovered lines")}: ${parse.formatRanges(parse.toRanges(lines), 20)}`,
    });
  });

  const needReport = async (what) => {
    const pick = await vscode.window.showInformationMessage(`There is no coverage report in this folder yet, so there is nothing to ${what}. Ask Friday to run the project's coverage?`, "Run coverage");
    if (pick) await vscode.commands.executeCommand("friday.runCoverage");
  };
  let busy = false;
  reg("friday.coverChanged", async () => {
    if (busy || repeat("changed")) return;
    busy = true;
    try {
      refresh();
      if (!cov) return needReport("read");
      const rows = [];
      const stales = [];
      const absent = [];
      let anyChange = false;
      for (const root of roots()) {
        const ch = await parse.changedRanges(root, (k) => cov.files.has(k));
        if (ch.size) anyChange = true;
        const c = parse.classifyChanges(cov, ch, (f) => stale(cov, f));
        rows.push(...c.rows);
        stales.push(...c.stale);
        absent.push(...c.absent);
      }
      if (!rows.length && !stales.length && !absent.length) {
        vscode.window.showInformationMessage(anyChange ? "Everything that changed is covered by the tests the report knows." : "Nothing has changed against the base branch yet.");
        return;
      }
      // What the report can't speak for goes in the ask by name: the agent runs coverage first, then covers what it finds there.
      const names = (list) => list.slice(0, MAX_FILES).map(rel).join(", ") + (list.length > MAX_FILES ? ` and ${list.length - MAX_FILES} more` : "");
      const text = rows.slice(0, MAX_FILES).map((r) => `${rel(r.file)}: ${parse.formatRanges(parse.toRanges(r.lines), 25)}`);
      if (stales.length) text.push(`Changed since the report: ${names(stales)}`);
      if (absent.length) text.push(`Not in the report: ${names(absent)}`);
      const first = rows[0];
      const ranges = first ? parse.toRanges(first.lines) : [[1, 1]];
      const count = rows.reduce((n, r) => n + r.lines.length, 0);
      const said = [];
      if (rows.length) said.push(`${count} changed ${count === 1 ? "line" : "lines"} in ${plural(rows.length, "file", "files")} are not covered`);
      if (stales.length) said.push(`${plural(stales.length, "file", "files")} changed since the report was made`);
      if (absent.length) said.push(`${plural(absent.length, "source file", "source files")} not in the report`);
      const ok = await postAsk({
        kind: "cover",
        path: first ? first.file : stales[0] || absent[0],
        from: ranges[0][0],
        to: ranges[0][1],
        text: text.join("\n"),
        root: roots()[0] || "",
        problem: "changed",
        source: `${said.join("; ")}. Coverage is ${cov.pct}% (${cov.report}).`,
      });
      if (ok && vscode.window.setStatusBarMessage) vscode.window.setStatusBarMessage("Sent to Friday's agent panel", 2500);
    } finally {
      busy = false;
    }
  });
  reg("friday.runCoverage", async () => {
    if (repeat("run")) return;
    const ok = await postAsk({ kind: "cover", path: "", from: 1, to: 1, text: "", root: roots()[0] || "", problem: "run", source: cov ? `Coverage was ${cov.pct}% (${cov.report}).` : "" });
    if (ok && vscode.window.setStatusBarMessage) vscode.window.setStatusBarMessage("Sent to Friday's agent panel", 2500);
  });
  reg("friday.showCoverage", async () => {
    // A switch: the same command turns it off again.
    const next = !on();
    // Written where the value is set now (a folder's or the workspace's own setting would otherwise win over the user's).
    const T = vscode.ConfigurationTarget;
    const at = cfg().inspect ? cfg().inspect("coverage") : null;
    const target = !T ? true : at && at.workspaceFolderValue !== undefined ? T.WorkspaceFolder : at && at.workspaceValue !== undefined ? T.Workspace : T.Global;
    await cfg().update("coverage", next, target);
    if (next && !cov) await needReport("show");
  });
  reg("friday.refreshCoverage", () => refresh(true));

  // ---- the Coverage view: the figure, the two buttons, the switch, and the files with the most lines never run.
  if (vscode.window.createTreeView && treeChanged) {
    const item = (label, o = {}) => {
      const t = new vscode.TreeItem(label, o.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      if (o.description) t.description = o.description;
      if (o.tooltip) t.tooltip = o.tooltip;
      if (o.icon && vscode.ThemeIcon) t.iconPath = new vscode.ThemeIcon(o.icon);
      if (o.command) t.command = { command: o.command, title: label, arguments: o.args };
      t.contextValue = o.context || "";
      return t;
    };
    const provider = {
      onDidChangeTreeData: treeChanged.event,
      getChildren(node) {
        if (!cov) return [];
        if (node && node.files) return node.files;
        const worst = [...cov.files.values()]
          .map((f) => ({ f, bad: parse.uncoveredLines(f).length, all: f.lines.size }))
          .filter((x) => x.bad > 0)
          .sort((a, b) => b.bad - a.bad)
          .slice(0, 15)
          .map((x) => ({ leaf: x }));
        return [
          { row: item(`${cov.pct}% of lines covered`, { description: cov.report, tooltip: `${plural(cov.hit, "line", "lines")} of ${cov.found} run in the tests (${cov.report}).`, icon: "beaker" }) },
          { row: item("Write tests for what changed", { description: "against the base branch", icon: "sparkle", command: "friday.coverChanged", tooltip: "Friday writes tests for the changed lines no test runs, runs them, and runs coverage again" }) },
          { row: item("Run coverage", { icon: "play", command: "friday.runCoverage", tooltip: "Friday finds the project's coverage command, runs it and refreshes this report" }) },
          { row: item("Show coverage in the editors", { description: on() ? "on" : "off", icon: on() ? "eye" : "eye-closed", command: "friday.showCoverage", tooltip: "Mark the lines no test runs, and add Test above each function that has some" }) },
          ...(worst.length ? [{ row: item("Least covered", { children: true }), files: worst }] : []),
        ];
      },
      getTreeItem(node) {
        if (node.row) return node.row;
        const { f, bad, all } = node.leaf;
        return item(path.basename(f.file), { description: `${bad} not run · ${Math.round(((all - bad) / all) * 100)}%`, tooltip: f.file, icon: "file", command: "vscode.open", args: [vscode.Uri.file(f.file)] });
      },
    };
    const view = vscode.window.createTreeView("friday.coverage", { treeDataProvider: provider, showCollapseAll: false });
    context.subscriptions.push(view);
  }

  // ---- following the report, the settings and the editors.
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => (e.affectsConfiguration("friday.coverage") || e.affectsConfiguration("friday.functionActions")) && repaint()));
  if (vscode.window.onDidChangeVisibleTextEditors) context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(paint));
  // A save moves lines: the file's marks go until a new report (stale), without waiting for one. Only repainted: the report is
  // not read again unless a report file changed.
  if (vscode.workspace.onDidSaveTextDocument) context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => later(repaint)));
  const sig = () => roots().map((r) => parse.findReports(r).map((x) => `${x.file}:${x.mtime}`).join("|")).join("||");
  let seen = sig();
  if (vscode.workspace.createFileSystemWatcher && vscode.RelativePattern) {
    for (const root of roots()) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "{coverage/lcov.info,lcov.info,coverage/coverage-final.json,coverage/cobertura-coverage.xml,coverage.xml,cobertura.xml}"));
      for (const ev of ["onDidChange", "onDidCreate", "onDidDelete"]) if (w[ev]) context.subscriptions.push(w[ev](() => (seen = sig(), later(refresh))));
      context.subscriptions.push(w);
    }
  }
  // The watcher doesn't see every file system (and a coverage folder is often ignored by it): a slow look stands behind it.
  const poll = setInterval(() => {
    const now = sig();
    if (now !== seen) (seen = now), later(refresh);
  }, 5000);
  if (poll.unref) poll.unref();
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  refresh(true);
  return { refresh, state: () => cov };
}

module.exports = { register, loadAll, stale };
