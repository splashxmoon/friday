"use strict";
// Keep / Undo on the blocks an agent changed, in the editor itself (Arun, 2026-11-19, the five IDE features: "Select code, say
// 'make this async'... and the change appears in place as a diff with Keep / Undo", "While an agent works, its edits stream into
// open files with Keep / Undo on each changed block... your typing never clobbers theirs"). One module for both the inline edit
// (⌘K) and an agent working on its own: each is a file with a BASE (the text before the agent) and the text now; the blocks
// between them get a green marker, a CodeLens "Keep ⌘↵ / Undo ⌘⌫", and a hover with what was removed.
//   Keep  = the block becomes the base's: the mark goes, the file stays as it is.
//   Undo  = the block's lines are put back to the base's, in the editor's buffer, so the editor's own undo can take it back.
// A file the person has unsaved edits in is never written over: their typing only moves the blocks, and Undo of a block they
// typed in asks first. The diff itself is diff.js (pure, tested apart).
const fsMod = require("node:fs");
const path = require("node:path");
const { hunksOf, shiftHunks, typedOutside, undoEdit, keepBase, splitLines } = require("./diff");

const MAC = process.platform === "darwin";
const KEEP = MAC ? "Keep ⌘↵" : "Keep Ctrl+↵";
const UNDO = MAC ? "Undo ⌘⌫" : "Undo Ctrl+⌫";
/** A candidate (a change seen before Friday has said an agent is running) is dropped after this long unconfirmed. */
const CANDIDATE_MS = 45000;
/** An edit asked for and not yet answered is dropped after this long. */
const PENDING_MS = 10 * 60 * 1000;

function createMarks(vscode, host) {
  const sessions = new Map();
  const lastClean = new Map();
  // What the person settled in each file (Keep, Keep all, Undo all, or the last block gone): the text they left it at. A run that is
  // still going does not bring those blocks back: the next marks start from this text, and a file that is still it has none.
  const settled = new Map();
  const changed = vscode.EventEmitter ? new vscode.EventEmitter() : null;
  let decos = null;
  const disposables = [];

  const key = (uri) => uri.fsPath;
  const docOf = (fsPath) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath && d.uri.scheme === "file");
  const eolOf = (doc) => (doc.eol === (vscode.EndOfLine && vscode.EndOfLine.CRLF) ? "\r\n" : "\n");

  function types() {
    if (decos || !vscode.window.createTextEditorDecorationType) return decos;
    const T = vscode.ThemeColor;
    const ruler = vscode.OverviewRulerLane ? vscode.OverviewRulerLane.Left : undefined;
    decos = {
      added: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new T("diffEditor.insertedLineBackground"),
        overviewRulerColor: new T("editorOverviewRuler.addedForeground"),
        overviewRulerLane: ruler,
        borderColor: new T("gitDecoration.addedResourceForeground"),
        borderStyle: "solid",
        borderWidth: "0 0 0 2px",
      }),
      // Lines taken away: a red line where they were, and how many; what they said is in the hover and "Compare".
      removed: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderColor: new T("gitDecoration.deletedResourceForeground"),
        borderStyle: "solid",
        borderWidth: "2px 0 0 0",
        overviewRulerColor: new T("editorOverviewRuler.deletedForeground"),
        overviewRulerLane: ruler,
      }),
      note: vscode.window.createTextEditorDecorationType({ isWholeLine: true }),
      pending: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new T("editor.rangeHighlightBackground"),
      }),
    };
    disposables.push(...Object.values(decos));
    return decos;
  }

  const live = (s) => !s.pending;

  function paint(editor) {
    const d = types();
    if (!d || !editor || !editor.setDecorations) return;
    const s = sessions.get(key(editor.document.uri));
    const added = [];
    const removed = [];
    const notes = [];
    const pend = [];
    if (s && live(s)) {
      const n = editor.document.lineCount;
      for (const h of s.hunks) {
        // A block that runs to the end of a file ending in a newline stops before the empty last line.
        let end = Math.min(h.b1, n);
        if (end === n && n > h.b0 + 1 && editor.document.lineAt(n - 1).range.end.character === 0) end--;
        if (h.b1 > h.b0) added.push(new vscode.Range(h.b0, 0, end - 1, 0));
        const gone = h.a1 - h.a0;
        if (gone && h.b0 < n) {
          removed.push(new vscode.Range(h.b0, 0, h.b0, 0));
          const first = splitLines(s.base)[h.a0].trim();
          const said = first ? `: ${first.length > 56 ? `${first.slice(0, 55)}…` : first}` : "";
          notes.push({
            range: new vscode.Range(h.b0, 0, h.b0, 0),
            renderOptions: { after: { contentText: `   −${gone} line${gone === 1 ? "" : "s"}${said}`, color: new vscode.ThemeColor("descriptionForeground"), fontStyle: "italic" } },
          });
        }
      }
      if (s.pend && !s.hunks.length) pend.push(new vscode.Range(s.pend.b0, 0, Math.min(s.pend.b1, n) - 1, 0));
    }
    editor.setDecorations(d.added, added);
    editor.setDecorations(d.removed, removed);
    editor.setDecorations(d.note, notes);
    editor.setDecorations(d.pending, pend);
  }
  function paintAll() {
    for (const e of vscode.window.visibleTextEditors || []) paint(e);
    updateContext();
    host.onChange && host.onChange();
  }

  /** The block under the cursor in the editor shown, for the keys (⌘↵ / ⌘⌫). */
  function blockAt(editor) {
    if (!editor) return null;
    const s = sessions.get(key(editor.document.uri));
    if (!s || !live(s)) return null;
    const line = editor.selection.active.line;
    const h = s.hunks.find((x) => (x.b1 > x.b0 ? line >= x.b0 && line < x.b1 : line === x.b0));
    return h ? { s, h } : null;
  }
  function updateContext() {
    if (!vscode.commands || !vscode.commands.executeCommand) return;
    // The keys (⌘↵ keep, ⌘⌫ undo) are Friday's only on the block's first line, where its lens is: inside it they stay the editor's own
    // (delete to line start, a line below), so editing the agent's code never undoes it by accident.
    const at = blockAt(vscode.window.activeTextEditor);
    const on = !!at && vscode.window.activeTextEditor.selection.active.line === Math.min(at.h.b0, vscode.window.activeTextEditor.document.lineCount - 1);
    const ed = vscode.window.activeTextEditor;
    const file = !!(ed && sessions.get(key(ed.document.uri)) && live(sessions.get(key(ed.document.uri))) && sessions.get(key(ed.document.uri)).hunks.length);
    Promise.resolve(vscode.commands.executeCommand("setContext", "friday.markAtCursor", on)).catch(() => {});
    Promise.resolve(vscode.commands.executeCommand("setContext", "friday.fileHasMarks", file)).catch(() => {});
  }

  /** A session over: the marks go, and the text the person settled on is remembered for the rest of the run. */
  function end(k, doc) {
    sessions.delete(k);
    const d = doc || docOf(k);
    if (d) settled.set(k, d.getText());
  }

  function refresh(s, doc) {
    const was = s.hunks.filter((h) => h.typed);
    const hunks = hunksOf(s.base, doc.getText());
    // What the person typed inside a block stays marked as theirs through a read of the file.
    for (const h of hunks) if (was.some((o) => o.b0 < Math.max(h.b1, h.b0 + 1) && h.b0 < Math.max(o.b1, o.b0 + 1))) h.typed = true;
    s.hunks = hunks;
    if (hunks.length) {
      s.seen = true;
      s.pend = null;
    } else if (s.seen || s.kind === "agent") {
      end(key(s.uri), doc);
    }
    if (changed) changed.fire();
    paintAll();
  }

  /** A file the agent works in, from this text on (an edit asked for: the whole file as it is now; the range is shown as waiting). */
  function begin(doc, opts) {
    const s = {
      uri: doc.uri,
      base: doc.getText(),
      kind: opts.kind,
      label: opts.label || "",
      tool: opts.tool || "",
      title: opts.title || "",
      hunks: [],
      seen: false,
      pend: opts.range ? { b0: opts.range.start.line, b1: opts.range.end.line + 1 } : null,
      pending: !!opts.pending,
      at: Date.now(),
      self: 0,
    };
    sessions.set(key(doc.uri), s);
    if (changed) changed.fire();
    paintAll();
    return s;
  }
  function drop(fsPath) {
    if (sessions.delete(fsPath)) {
      if (changed) changed.fire();
      paintAll();
    }
  }

  async function writeBack(s, doc, edit, wasDirty) {
    s.self++;
    try {
      const we = new vscode.WorkspaceEdit();
      if (edit.replace) we.replace(doc.uri, edit.replace.range, edit.replace.text);
      const ok = await vscode.workspace.applyEdit(we);
      // Saved only when the file had nothing unsaved before: then this edit is the only difference from the disk, and it is the
      // person's own pick. With unsaved typing in it, the buffer takes it and the file stays theirs to save.
      if (ok && !wasDirty && doc.isDirty) await doc.save();
      return ok;
    } finally {
      s.self--;
    }
  }

  async function undo(fsPath, hunkKey) {
    const s = sessions.get(fsPath);
    const doc = docOf(fsPath);
    if (!s || !doc) return;
    const h = s.hunks.find((x) => x.a0 === hunkKey.a0 && x.a1 === hunkKey.a1) || null;
    if (!h) return;
    const nowLines = splitLines(doc.getText());
    // A block the person has typed into since the agent wrote it: ask before their words go.
    if (h.typed) {
      const pick = await vscode.window.showWarningMessage("You have edited this block. Undo it anyway?", { modal: true }, "Undo it");
      if (pick !== "Undo it") return;
    }
    const e = undoEdit(s.base, h, nowLines, eolOf(doc));
    const lastLine = doc.lineCount - 1;
    const last = doc.lineAt(lastLine).range.end;
    const from = e.toEnd ? (e.joinPrev ? doc.lineAt(e.start - 1).range.end : new vscode.Position(0, 0)) : new vscode.Position(e.start, 0);
    const range = e.toEnd ? new vscode.Range(from, last) : new vscode.Range(e.start, 0, e.end, 0);
    const wasDirty = doc.isDirty;
    const ok = await writeBack(s, doc, { replace: { range, text: e.text } }, wasDirty);
    if (!ok) return vscode.window.showWarningMessage("Could not undo that block.");
    refresh(s, docOf(fsPath) || doc);
  }

  function keep(fsPath, hunkKey) {
    const s = sessions.get(fsPath);
    const doc = docOf(fsPath);
    if (!s || !doc) return;
    const h = s.hunks.find((x) => x.a0 === hunkKey.a0 && x.a1 === hunkKey.a1);
    if (!h) return;
    s.base = keepBase(s.base, h, splitLines(doc.getText()));
    // Kept: this block is the base's now. The others are read again against it.
    s.hunks = hunksOf(s.base, doc.getText());
    if (!s.hunks.length) end(fsPath, doc);
    if (changed) changed.fire();
    paintAll();
  }
  function keepAll(fsPath) {
    const s = sessions.get(fsPath);
    const doc = docOf(fsPath);
    if (!s || !doc) return;
    s.base = doc.getText();
    end(fsPath, doc);
    if (changed) changed.fire();
    paintAll();
  }
  async function undoAll(fsPath) {
    const s = sessions.get(fsPath);
    const doc = docOf(fsPath);
    if (!s || !doc) return;
    if (s.hunks.some((h) => h.typed)) {
      const pick = await vscode.window.showWarningMessage("You have edited these blocks. Undo them all anyway?", { modal: true }, "Undo all");
      if (pick !== "Undo all") return;
    }
    const wasDirty = doc.isDirty;
    const whole = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).range.end.character);
    const text = splitLines(s.base).join(eolOf(doc));
    const ok = await writeBack(s, doc, { replace: { range: whole, text } }, wasDirty);
    if (!ok) return;
    end(fsPath, docOf(fsPath) || doc);
    if (changed) changed.fire();
    paintAll();
  }

  // ---- the editor's own events -------------------------------------------------------------------------------------------

  function onChange(e) {
    const doc = e.document;
    if (doc.uri.scheme !== "file") return;
    const before = lastClean.get(key(doc.uri));
    try {
      changed1(e, before);
    } finally {
      // What the file was before its next change: kept current on every path, or a later change is read against a stale text.
      if (!doc.isDirty && e.contentChanges.length) lastClean.set(key(doc.uri), doc.getText());
    }
  }
  function changed1(e, before) {
    const doc = e.document;
    const k = key(doc.uri);
    let s = sessions.get(k);
    // An earlier change that no run claimed: not this change's base. Either a run is known and began after it, or none has claimed it
    // in the time a look at Friday takes.
    if (s && s.pending && !s.self && !host.agentRunning(k, s.at) && (host.agentRunning(k) || Date.now() - s.at > 5000)) {
      sessions.delete(k);
      s = undefined;
    }
    if (s) {
      if (s.self) return;
      if (!e.contentChanges.length) return paintAll();
      // Undo and redo in the editor are the person's too, even when they land back on the saved text (reason 1 and 2).
      if (doc.isDirty || e.reason === 1 || e.reason === 2) {
        // The person's typing. Outside every block it goes into the base as well, so the base follows them and a save (or the
        // agent's next write) reads to the agent's blocks alone; inside a block it stays that block's, marked as typed. The
        // lines an edit asked for and not yet got back count as a block: what is typed there is not written into the base.
        let hunks = s.hunks;
        let pend = s.pend ? [{ b0: s.pend.b0, b1: s.pend.b1, a0: -1, a1: -1 }] : [];
        for (const c of e.contentChanges) {
          const added = c.text.split("\n").length - 1;
          const inPend = pend.length && c.range.end.line >= pend[0].b0 && c.range.start.line < Math.max(pend[0].b1, pend[0].b0 + 1);
          const out = inPend
            ? null
            : typedOutside(s.base, hunks, { startLine: c.range.start.line, startChar: c.range.start.character || 0, endLine: c.range.end.line, endChar: c.range.end.character || 0, text: c.text });
          if (out) {
            s.base = out.base;
            hunks = out.hunks;
          } else {
            hunks = shiftHunks(hunks, c.range.start.line, c.range.end.line, added);
            for (const h of hunks) if (c.range.end.line >= h.b0 && c.range.start.line < Math.max(h.b1, h.b0 + 1)) h.typed = true;
          }
          pend = shiftHunks(pend, c.range.start.line, c.range.end.line, added);
        }
        s.hunks = hunks;
        s.pend = pend[0] ? { b0: pend[0].b0, b1: pend[0].b1 } : null;
        paintAll();
      } else {
        // Written to the disk by something else (the agent): the editor reloaded it. Read the blocks again.
        refresh(s, doc);
      }
      return;
    }
    if (!e.contentChanges.length) return;
    if (!doc.isDirty && e.reason !== 1 && e.reason !== 2 && before !== undefined && host.agentRunning && before !== doc.getText()) {
      // A file changed on disk with no marks yet. It might be an agent's write, or the person's own checkout, pull, formatter or
      // revert: a candidate, from the text just before, shown only once a running task names this file (Friday's word comes on a
      // poll, and the next one after this change is the one that can say so).
      const c = begin(doc, { kind: "agent", tool: "", pending: true });
      c.base = before;
      const timer = setTimeout(() => {
        const x = sessions.get(k);
        if (x && x === c && x.pending) {
          const tool = host.agentRunning(k, c.at);
          if (tool) {
            x.pending = false;
            x.tool = tool;
            refresh(x, docOf(k) || doc);
          } else drop(k);
        }
      }, CANDIDATE_MS);
      if (timer.unref) timer.unref();
      host.poll && host.poll();
    }
  }

  function remember(doc) {
    if (doc.uri.scheme !== "file" || doc.isUntitled || doc.isDirty) return;
    try {
      if (doc.lineCount < 20000) lastClean.set(key(doc.uri), doc.getText());
    } catch {
      // Not readable: no memory of it.
    }
  }

  // ---- what the editor shows: lenses, hovers, the compare view ------------------------------------------------------------

  const lensProvider = {
    onDidChangeCodeLenses: changed ? changed.event : undefined,
    provideCodeLenses(doc) {
      const s = sessions.get(key(doc.uri));
      if (!s || !live(s)) return [];
      const out = [];
      const who = s.kind === "edit" ? s.label : s.tool ? `${s.tool}` : "An agent";
      const text = who.length > 44 ? `${who.slice(0, 43)}…` : who;
      // Three links to a line at most: the skin reads four as a merge conflict's banner (vscode-skin.ts). The rest (Keep all, Undo all,
      // Compare) are in the editor's title and the command palette.
      s.hunks.forEach((h) => {
        const line = Math.min(h.b0, doc.lineCount - 1);
        const r = new vscode.Range(line, 0, line, 0);
        const arg = [doc.uri.fsPath, { a0: h.a0, a1: h.a1 }];
        out.push(new vscode.CodeLens(r, { title: `✳ ${text}`, command: "friday.marks.about", arguments: [s.kind === "edit" ? s.label : who] }));
        out.push(new vscode.CodeLens(r, { title: KEEP, command: "friday.marks.keep", arguments: arg, tooltip: "Keep this change" }));
        out.push(new vscode.CodeLens(r, { title: UNDO, command: "friday.marks.undo", arguments: arg, tooltip: "Put this block back as it was" }));
      });
      return out;
    },
  };

  const hoverProvider = {
    provideHover(doc, pos) {
      const s = sessions.get(key(doc.uri));
      if (!s || !live(s)) return undefined;
      const h = s.hunks.find((x) => pos.line === x.b0 || (pos.line >= x.b0 && pos.line < x.b1));
      if (!h || h.a1 === h.a0) return undefined;
      const was = splitLines(s.base).slice(h.a0, h.a1).slice(0, 30);
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Before** · ${h.a1 - h.a0} line${h.a1 - h.a0 === 1 ? "" : "s"} removed\n\n`);
      md.appendCodeblock(was.map((l) => `- ${l}`).join("\n"), "diff");
      return new vscode.Hover(md);
    },
  };

  const SCHEME = "friday-before";
  const contentProvider = {
    provideTextDocumentContent(uri) {
      const s = sessions.get(decodeURIComponent(uri.query));
      return s ? s.base : "";
    },
  };

  async function compare(fsPath) {
    const s = sessions.get(fsPath);
    if (!s) return;
    const left = vscode.Uri.from ? vscode.Uri.from({ scheme: SCHEME, path: s.uri.path, query: encodeURIComponent(fsPath) }) : s.uri;
    await vscode.commands.executeCommand("vscode.diff", left, s.uri, `${path.basename(fsPath)} · before ↔ now`);
  }

  function register(context) {
    const R = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    const here = () => {
      const b = blockAt(vscode.window.activeTextEditor);
      return b ? [b.s.uri.fsPath, { a0: b.h.a0, a1: b.h.a1 }] : null;
    };
    R("friday.marks.keep", (p, h) => (typeof p === "string" ? keep(p, h) : (here() ? keep(...here()) : undefined)));
    R("friday.marks.undo", (p, h) => (typeof p === "string" ? undo(p, h) : (here() ? undo(...here()) : undefined)));
    // From the editor's title the first argument is a Uri, not a path: only a string is taken as the file.
    const file = (p) => (typeof p === "string" ? p : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath);
    R("friday.marks.keepAll", (p) => {
      const f = file(p);
      if (f) keepAll(f);
    });
    R("friday.marks.undoAll", (p) => {
      const f = file(p);
      if (f) return undoAll(f);
    });
    R("friday.marks.compare", (p) => compare(file(p)));
    R("friday.marks.about", () => {});
    if (vscode.languages) {
      if (vscode.languages.registerCodeLensProvider) context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: "file" }, lensProvider));
      if (vscode.languages.registerHoverProvider) context.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: "file" }, hoverProvider));
    }
    if (vscode.workspace.registerTextDocumentContentProvider) context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider));
    const w = vscode.workspace;
    for (const d of w.textDocuments || []) remember(d);
    if (w.onDidOpenTextDocument) context.subscriptions.push(w.onDidOpenTextDocument(remember));
    if (w.onDidChangeTextDocument) context.subscriptions.push(w.onDidChangeTextDocument(onChange));
    if (w.onDidSaveTextDocument) {
      context.subscriptions.push(
        w.onDidSaveTextDocument((doc) => {
          // Saved by the person: the base has followed what they typed outside the blocks, so a read now finds the agent's blocks
          // alone (and what was typed inside one is still marked as theirs).
          const s = sessions.get(key(doc.uri));
          if (s && live(s) && !s.self && s.hunks.length) refresh(s, doc);
          remember(doc);
        }),
      );
    }
    if (w.onDidCloseTextDocument) context.subscriptions.push(w.onDidCloseTextDocument((doc) => lastClean.delete(key(doc.uri))));
    const win = vscode.window;
    if (win.onDidChangeVisibleTextEditors) context.subscriptions.push(win.onDidChangeVisibleTextEditors(() => paintAll()));
    if (win.onDidChangeActiveTextEditor) context.subscriptions.push(win.onDidChangeActiveTextEditor(() => paintAll()));
    if (win.onDidChangeTextEditorSelection) context.subscriptions.push(win.onDidChangeTextEditorSelection(() => updateContext()));
    context.subscriptions.push({ dispose: () => disposables.forEach((d) => d.dispose && d.dispose()) });
    // Sessions that never came to anything (an edit asked for and never answered, a candidate never confirmed) are let go.
    const sweep = setInterval(() => {
      for (const [k, s] of sessions) {
        if (!s.hunks.length && Date.now() - s.at > (s.pending ? CANDIDATE_MS * 2 : PENDING_MS)) drop(k);
      }
    }, 30000);
    if (sweep.unref) sweep.unref();
    context.subscriptions.push({ dispose: () => clearInterval(sweep) });
  }

  return {
    register,
    begin,
    drop,
    refresh,
    remember,
    sessions,
    docOf,
    has: (fsPath) => sessions.has(fsPath),
    /** The text the person last settled this file at (Keep, Undo all), or undefined. */
    settledText: (fsPath) => settled.get(fsPath),
    /** The sessions an agent's run owns, for the status line. */
    all: () => [...sessions.values()],
    exists: (p) => fsMod.existsSync(p),
  };
}

module.exports = { createMarks, KEEP, UNDO };
