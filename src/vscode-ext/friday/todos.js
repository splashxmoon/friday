"use strict";
// TODOs become tasks (Arun, 2026-11-19, wave 4: "TODOs become tasks: Friday finds the TODO and FIXME comments in your repo, lists
// them, and hands any of them to an agent in one click."): a TODOs view in the Friday container (grouped by file, each row "line ·
// text", who wrote it and when once a file is opened out), "✳ Do this" above each marker comment in the editor, and the ask to
// Friday that starts a chat named "TODO file:line". The finding is todo-parse.js. Plain CommonJS; the vscode API is passed in so a
// test can hand it a stand-in.
const fs = require("node:fs");
const path = require("node:path");
const parse = require("./todo-parse.js");

const AROUND = 10;
const MAX_TEXT = 20000;
const TAG_ICON = { TODO: "circle-large-outline", FIXME: "bug", HACK: "warning", XXX: "alert" };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Lines `line`-AROUND to `line`+AROUND of a text, and the range they are (1-based). */
function around(text, line) {
  const all = String(text).split(/\r\n|\r|\n/);
  const from = Math.max(1, line - AROUND);
  const to = Math.min(all.length, line + AROUND);
  return { from, to, text: all.slice(from - 1, to).join("\n").slice(0, MAX_TEXT) };
}

/** The ask for one marker: its words, its tag and line, and the lines around it. Pure. */
function todoAsk(file, root, hit, text) {
  const near = around(text, hit.line);
  return { kind: "todo", path: file, from: near.from, to: near.to, text: near.text, root, line: hit.line, problem: hit.text, source: hit.tag };
}

function register(vscode, context, { postAsk, roots, rootOf }) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const cfg = () => vscode.workspace.getConfiguration("friday");
  const treeChanged = vscode.EventEmitter ? new vscode.EventEmitter() : null;
  const lensChanged = vscode.EventEmitter ? new vscode.EventEmitter() : null;
  if (treeChanged) context.subscriptions.push(treeChanged, lensChanged);

  // ---- what is in the folders: file -> { file, rel, root, hits }.
  let found = [];
  let capped = { files: false, hits: false }; // a cap stopped the reading: the list is not the whole truth
  let scanning = false;
  let again = false;
  let scannedAt = 0;
  let timer;
  const opened = new Set(); // files whose group the person has opened out
  const total = () => found.reduce((n, f) => n + f.hits.length, 0);
  const short = () => found.length <= 6 && total() <= 12;
  const publish = () => {
    if (vscode.commands && vscode.commands.executeCommand) {
      const set = (k, v) => void Promise.resolve(vscode.commands.executeCommand("setContext", k, v)).catch(() => {});
      set("friday.hasTodos", found.length > 0);
      // Until the first look is done the view says it is looking, not that there is nothing.
      set("friday.todosScanned", scannedAt > 0);
    }
    if (view) {
      const n = total();
      // No badge: the number on the Friday icon means what waits on the person, and a repo's TODO comments are always there.
      view.description = n ? `${n}${capped.hits ? "+" : ""} in ${plural(found.length, "file", "files")}${capped.files ? " \u00b7 partial" : ""}` : "";
    }
    if (treeChanged) treeChanged.fire();
  };
  const scan = async () => {
    if (scanning) return void (again = true);
    scanning = true;
    try {
      const exclude = vscode.workspace.getConfiguration("files").get("exclude", {});
      const next = [];
      const cap = { files: false, hits: false };
      for (const root of roots()) {
        const got = await parse.scanFolder(root, { exclude });
        if (got.capped) (cap.files = cap.files || got.capped.files), (cap.hits = cap.hits || got.capped.hits);
        for (const f of got) next.push({ ...f, root });
      }
      // A cap on the whole: the first 500 by file name.
      let left = parse.MAX_HITS;
      found = next.filter((f) => left > 0 && (left -= f.hits.length, true));
      if (found.length < next.length) cap.hits = true;
      capped = cap;
      // The authors read before belong to lines that may have moved.
      blames.clear();
      for (const f of found) ver.set(f.file, (ver.get(f.file) || 0) + 1);
      scannedAt = Date.now();
    } catch {
      // The old list stands.
      scannedAt = scannedAt || Date.now();
    } finally {
      scanning = false;
      publish();
      readAuthors(found);
      if (again) {
        again = false;
        later(500);
      }
    }
  };
  const later = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), ms);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });

  // ---- one file read again (a save, or a change on disk made by an agent, a pull or a checkout).
  const sep = path.sep;
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  /** The folder a file is in, compared with a separator on the end: "/a/foobar" is not in "/a/foo". */
  const rootFor = (file) =>
    roots().find((r) => {
      const base = r.endsWith(sep) ? r : r + sep;
      return same(file, r) || same(file.slice(0, base.length), base);
    });
  /** The same tests the folder scan makes, for one file, before it is listed: kind of file, build folders, files.exclude, git's ignore, size. */
  const worth = async (file, root) => {
    const rel0 = path.relative(root, file);
    if (!rel0 || path.isAbsolute(rel0) || rel0.startsWith("..")) return null;
    const rel = rel0.split(path.sep).join("/");
    if (!parse.styleFor(rel) || parse.SKIP_DIRS.test(rel)) return null;
    const exclude = vscode.workspace.getConfiguration("files").get("exclude", {});
    if (parse.excluder(exclude)(rel)) return null;
    if (await parse.isIgnored(root, rel)) return null;
    return rel;
  };
  const apply = (file, rel, root, hits) => {
    const mine = found.findIndex((f) => f.file === file);
    // The folder-wide cap holds here too: a file new to the list does not push it past the hits it keeps.
    const others = total() - (mine >= 0 ? found[mine].hits.length : 0);
    if (hits.length && mine < 0 && others >= parse.MAX_HITS) {
      capped = { ...capped, hits: true };
      return;
    }
    if (hits.length) {
      const row = { file, rel, root, hits: hits.slice(0, Math.max(1, parse.MAX_HITS - others)) };
      if (mine >= 0) found[mine] = row;
      else {
        found.push(row);
        found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      }
    } else if (mine >= 0) found.splice(mine, 1);
    else return;
    // Only this file's authors are dropped (its lines may have moved), and read again at once when its group is open.
    dropBlames(file);
    publish();
    const row = found.find((f) => f.file === file);
    if (row && (short() || opened.has(file))) void blameFile(row);
  };
  /** A saved file: read from the editor's text. */
  const rescanFile = async (doc) => {
    if (!doc || !doc.uri || doc.uri.scheme !== "file") return;
    const file = doc.uri.fsPath;
    const root = rootFor(file);
    if (!root) return;
    const mine = found.some((f) => f.file === file);
    const hits0 = doc.lineCount > 60000 ? [] : parse.scanText(doc.getText(), file);
    if (!hits0.length && !mine) return;
    const rel = await worth(file, root);
    if (!rel) {
      if (mine) apply(file, "", root, []);
      return;
    }
    apply(file, rel, root, hits0);
  };
  /** A file changed on disk behind the editor: read from the disk (or, if an editor has it open with unsaved words, from there). */
  const rescanDisk = async (file) => {
    const root = rootFor(file);
    if (!root) return;
    const mine = found.some((f) => f.file === file);
    let text = "";
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size > parse.MAX_BYTES) throw new Error("skip");
      text = await fs.promises.readFile(file, "utf8");
      if (text.indexOf("\0") >= 0) text = "";
    } catch {
      // Deleted, or not a file worth reading: it has none.
    }
    const hits = parse.scanText(text, file);
    if (!hits.length && !mine) return;
    const rel = hits.length ? await worth(file, root) : "";
    apply(file, rel || "", root, rel ? hits : []);
  };
  // Files changed, created or deleted on disk, a few at a time. A big batch (a checkout, a pull) is read as a whole instead.
  const dirty = new Set();
  let dirtyTimer;
  const touched = (uri) => {
    if (!uri || uri.scheme !== "file") return;
    const file = uri.fsPath;
    if (!rootFor(file) || /(?:^|[\\/])\.git[\\/]/.test(file) || parse.SKIP_DIRS.test(file.split(sep).join("/") + "/")) return;
    dirty.add(file);
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => {
      const files = [...dirty];
      dirty.clear();
      if (files.length > 40) return void later(300);
      for (const f of files) void rescanDisk(f);
    }, 400);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(dirtyTimer) });

  // ---- who wrote a line and when: asked of git for one line at a time, only for a file the person opened out (or a short list).
  const blames = new Map();
  const ver = new Map(); // per file: bumped when its lines may have moved, so a read that was under way is let go
  const dropBlames = (file) => {
    for (const k of [...blames.keys()]) if (k.startsWith(`${file}:`)) blames.delete(k);
    ver.set(file, (ver.get(file) || 0) + 1);
  };
  const blameOf = (f, h) => blames.get(`${f.file}:${h.line}`);
  const fetchBlame = async (f, h) => {
    const key = `${f.file}:${h.line}`;
    if (blames.has(key)) return blames.get(key);
    const v = ver.get(f.file) || 0;
    blames.set(key, null);
    const b = await parse.blameLine(f.file, h.line).catch(() => null);
    if ((ver.get(f.file) || 0) === v) blames.set(key, b);
    return b;
  };
  const blameFile = async (f) => {
    let any = false;
    for (const h of f.hits.slice(0, 30)) {
      if (blames.has(`${f.file}:${h.line}`)) continue;
      await fetchBlame(f, h);
      any = true;
    }
    if (any && treeChanged) treeChanged.fire();
  };
  /** A short list is drawn opened out already (nothing to click), so its authors are read now; a long one waits for the click. */
  const readAuthors = (list) => {
    for (const f of list) if (short() || opened.has(f.file)) void blameFile(f);
  };

  // ---- the ask.
  let last = { key: "", at: 0 };
  const repeat = (key) => {
    if (key === last.key && Date.now() - last.at < 1500) return true;
    last = { key, at: Date.now() };
    return false;
  };
  const textOf = (file) => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (doc) return doc.getText();
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  /** A marker given as a view row ({ f, h }), or as the lens gives it (uri, line, hit fields). */
  const handOne = async (file, line, hit) => {
    if (repeat(`todo|${file}|${line}`)) return;
    // The row may be older than the file (an agent or a pull changed it): the marker is found again in the text as it is now,
    // nearest to where it was, and if it is gone nothing is sent.
    const text = textOf(file);
    const now = parse
      .scanText(text, file)
      .filter((h) => h.tag === hit.tag && h.text === hit.text)
      .sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
    if (!now) {
      if (vscode.window.setStatusBarMessage) vscode.window.setStatusBarMessage("That comment is gone from the file", 2500);
      later(100);
      return;
    }
    const root = rootFor(file) || rootOf(vscode.Uri.file(file));
    const ok = await postAsk(todoAsk(file, root, { line: now.line, tag: now.tag, text: now.text }, text));
    if (ok && vscode.window.setStatusBarMessage) vscode.window.setStatusBarMessage("Sent to Friday's agent panel", 2500);
  };
  reg("friday.todo.hand", (node, line, hit) => {
    if (node && node.leaf) return handOne(node.f.file, node.h.line, node.h);
    // From the lens: a uri, the line and the marker.
    if (node && node.fsPath && line && hit) return handOne(node.fsPath, line, hit);
  });
  const openAt = async (file, line) => {
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(pos, pos), preview: true });
  };
  reg("friday.todo.open", (node) => (node && node.leaf ? openAt(node.f.file, node.h.line) : undefined));
  reg("friday.todo.refresh", () => scan());

  // ---- the view.
  let view = null;
  if (vscode.window.createTreeView && treeChanged) {
    const item = (label, o = {}) => {
      const t = new vscode.TreeItem(label, o.state === undefined ? vscode.TreeItemCollapsibleState.None : o.state);
      if (o.id) t.id = o.id;
      if (o.description) t.description = o.description;
      if (o.tooltip) t.tooltip = o.tooltip;
      if (o.icon && vscode.ThemeIcon) t.iconPath = new vscode.ThemeIcon(o.icon);
      if (o.resource) t.resourceUri = o.resource;
      if (o.command) t.command = { command: o.command, title: o.title || label, arguments: o.args };
      t.contextValue = o.context || "";
      return t;
    };
    const provider = {
      onDidChangeTreeData: treeChanged.event,
      getChildren(node) {
        if (!node) {
          const rows = found.map((f) => ({ file: f }));
          const why = [capped.files && "Only the first 2,000 files were read", capped.hits && `Only the first ${parse.MAX_HITS} comments are listed`].filter(Boolean).join(". ");
          if (why && rows.length) rows.push({ note: why });
          return rows;
        }
        if (node.file) return node.file.hits.map((h) => ({ leaf: true, f: node.file, h }));
        return [];
      },
      getTreeItem(node) {
        if (node.note) return item(node.note, { id: "note", icon: "info", tooltip: "This list is not the whole folder. Open the files you care about, or exclude folders in files.exclude." });
        if (node.file) {
          const f = node.file;
          const dir = path.dirname(f.rel);
          const open = found.length <= 6 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
          return item(path.basename(f.rel), { id: `file|${f.file}`, state: open, description: `${dir === "." ? "" : `${dir} · `}${f.hits.length}`, tooltip: f.file, resource: vscode.Uri.file(f.file), icon: "file", context: "friday.todoFile" });
        }
        const { f, h } = node;
        const b = blameOf(f, h);
        // The row's words come first in a narrow column, so beside them only a first name: the whole of it is in the tooltip.
        const who = b ? b.author.split(/\s+/)[0] : h.who;
        return item(`${h.line} · ${h.text || h.tag}`, {
          id: `todo|${f.file}|${h.line}|${h.text}`,
          description: who || undefined,
          tooltip: `${h.tag}${h.who ? `(${h.who})` : ""}: ${h.text || "(no words)"}\n${f.rel}:${h.line}${b ? `\nWritten by ${b.author}${b.at ? `, ${parse.ago(b.at)}` : ""}` : ""}`,
          icon: TAG_ICON[h.tag] || "circle-large-outline",
          command: "friday.todo.open",
          title: "Open",
          args: [node],
          context: "friday.todo",
        });
      },
    };
    view = vscode.window.createTreeView("friday.todos", { treeDataProvider: provider, showCollapseAll: true });
    context.subscriptions.push(view);
    // A file opened out: who wrote each of its markers, one line of git blame each, for this file only.
    if (view.onDidExpandElement) context.subscriptions.push(view.onDidExpandElement((e) => e.element && e.element.file && (opened.add(e.element.file.file), void blameFile(e.element.file))));
    if (view.onDidCollapseElement) context.subscriptions.push(view.onDidCollapseElement((e) => e.element && e.element.file && opened.delete(e.element.file.file)));
  }

  // ---- "✳ Do this" above each marker, in the editors (from the editor's own text, so an unsaved TODO has it at once).
  if (vscode.languages && vscode.languages.registerCodeLensProvider && vscode.CodeLens && vscode.Range) {
    const provider = {
      onDidChangeCodeLenses: lensChanged ? lensChanged.event : undefined,
      provideCodeLenses(document) {
        if (cfg().get("todoActions", true) === false || document.lineCount > 20000 || document.uri.scheme !== "file") return [];
        const out = [];
        for (const h of parse.scanText(document.getText(), document.uri.fsPath, 60)) {
          out.push(new vscode.CodeLens(new vscode.Range(h.line - 1, 0, h.line - 1, 0), { command: "friday.todo.hand", title: "✳ Do this", tooltip: `Hand this ${h.tag} to an agent with Friday: it does it and removes the comment`, arguments: [document.uri, h.line, { tag: h.tag, text: h.text }] }));
        }
        return out;
      },
    };
    context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: "file" }], provider));
  }

  // ---- following the folder: a save reads that file; created, deleted and renamed files, a folder change and a long
  // time away read it all again.
  if (vscode.workspace.onDidSaveTextDocument) context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((d) => void rescanFile(d)));
  // Changes made on disk by something else (an agent doing the TODO, a pull, a checkout) reach the list too: a saved-in-editor
  // event never fires for them.
  if (vscode.workspace.createFileSystemWatcher && vscode.RelativePattern) {
    for (const root of roots()) {
      try {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*"));
        context.subscriptions.push(w, w.onDidChange(touched), w.onDidCreate(touched), w.onDidDelete(touched));
      } catch {
        // No watching: saves and the scan on returning to the window still follow along.
      }
    }
  }
  for (const ev of ["onDidCreateFiles", "onDidDeleteFiles", "onDidRenameFiles", "onDidChangeWorkspaceFolders"]) if (vscode.workspace[ev]) context.subscriptions.push(vscode.workspace[ev](() => later(1500)));
  if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && Date.now() - scannedAt > 60000 && later(300)));
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => (e.affectsConfiguration("friday.todoActions") && lensChanged && lensChanged.fire()) || (e.affectsConfiguration("files.exclude") && later(500))));
  // First look a moment after start-up, not in the way of it.
  later(2000);
  return { scan, state: () => found, capped: () => capped, touched, rescanFile };
}

module.exports = { register, todoAsk, around };
