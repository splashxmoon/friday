"use strict";
// The IDE's inline edit (⌘K) and live agent edits (Arun, 2026-11-19, the five IDE features). Both end in marks.js: a file, the
// text before the agent, and Keep / Undo on each block that changed.
//   ⌘K: select code, say what to change; Friday starts a chat for it in the background, told to touch only those lines; when
//       the file changes on disk, the block shows in place with Keep / Undo ("No chat needed for small edits").
//   Live: while a task of Code's is running, each file it changes shows its blocks against git HEAD (or the text just before the
//       change), with Keep / Undo, "✳ <tool> is editing" in the status bar, and, if the person turns it on, each file opens
//       beside the editor as the agent edits it ("Follow the agent": off by default, never takes focus).
const { execFile } = require("node:child_process");
const path = require("node:path");
const { createMarks } = require("./marks");
const { hunksOf } = require("./diff");

/** What a short instruction the tab and the lens can carry. */
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
const sameDir = (file, root) => {
  const f = norm(file);
  const r = norm(root);
  const win = /^[a-z]:\//i.test(f);
  return (win ? f.toLowerCase() : f).startsWith(`${win ? r.toLowerCase() : r}/`);
};

/** A file as git has it at a commit (HEAD by default), or null (not in git, not there, or the commit is not in this repository). No shell. */
function gitHead(file, rev = "HEAD") {
  return new Promise((resolve) => {
    try {
      execFile("git", ["show", `${rev}:./${path.basename(file)}`], { cwd: path.dirname(file), maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
    } catch {
      resolve(null);
    }
  });
}

function activateEdits(context, vscode, host) {
  let tasks = [];
  let polled = false;
  // Each (task, file) looked at against git once: Keep or Undo in it is then the person's word for the rest of the run.
  const headTried = new Set();
  const followed = new Set();
  // Chats this window asked for with ⌘K, by their title: the page's "changed a file" notice is not sent for these.
  const asked = new Map();
  const marks = createMarks(vscode, {
    onChange: () => status(),
    agentRunning: (file, since) => runningTool(file, since),
    poll: () => host.poll && host.poll(),
  });
  marks.register(context);

  const mine = (x) => !x.folder || host.roots().some((r) => norm(r) === norm(x.folder) || sameDir(x.folder, r) || sameDir(r, x.folder));
  const running = () => tasks.filter((x) => x.status === "running" && mine(x));
  const pathOf = (p) => vscode.Uri.file(p).fsPath;
  /**
   * The tool name of the running task that lists this file as changed; "" when none does. A run that does not name the file is not
   * who changed it (the person's own checkout, pull or formatter changes files while one runs). With `since` (when a change was
   * seen), only a run that began before it counts: a task started after is not who changed that.
   */
  function runningTool(file, since) {
    const own = running().find((x) => (!since || !x.since || x.since <= since) && listed(x, file));
    return own ? host.TOOL[own.tool] || "An agent" : "";
  }
  /** Whether a task names this file: its change set (reported when a turn ends) or the edit calls it has made in the run so far. */
  const listed = (x, file) => (x.files || []).some((f) => pathOf(f.path) === file) || (x.editing || []).some((p) => pathOf(p) === file);

  // ---- ⌘K ----------------------------------------------------------------------------------------------------------------

  function ask(title, placeholder) {
    return new Promise((resolve) => {
      if (!vscode.window.createInputBox) return resolve(vscode.window.showInputBox ? vscode.window.showInputBox({ title, placeHolder: placeholder }) : undefined);
      const box = vscode.window.createInputBox();
      box.title = title;
      box.placeholder = placeholder;
      let done = false;
      const end = (v) => {
        if (done) return;
        done = true;
        resolve(v);
        box.dispose();
      };
      box.onDidAccept(() => end(box.value.trim() || undefined));
      box.onDidHide(() => end(undefined));
      box.show();
    });
  }

  async function editWithAgent() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (doc.uri.scheme !== "file") return vscode.window.showInformationMessage("Open a file from this folder to edit it with an agent.");
    // Marks already in this file are the person's to settle first: a second ask on top would take the first one's Keep / Undo away.
    const there = marks.sessions.get(doc.uri.fsPath);
    if (there && !there.pending) return vscode.window.showInformationMessage("Keep or Undo the marked changes in this file first, then ask again.");
    const version = doc.version;
    const sel = editor.selection;
    const range = sel && !sel.isEmpty ? sel : doc.lineAt(sel ? sel.active.line : 0).range;
    // A selection that ends at the very start of a line doesn't take that line.
    const lastLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
    const from = range.start.line + 1;
    const to = lastLine + 1;
    const lines = to === from ? `line ${from}` : `lines ${from}–${to}`;
    const instruction = await ask(`✳ Edit ${lines} of ${path.basename(doc.uri.fsPath)}`, 'Say what to change, like "make this async" or "handle the 429"');
    if (!instruction) return;
    // Lines picked before the box opened mean nothing if the file changed meanwhile (an agent's write): ask again on what is there.
    if (doc.version !== version || (marks.sessions.get(doc.uri.fsPath) && !marks.sessions.get(doc.uri.fsPath).pending)) {
      return vscode.window.showInformationMessage("The file changed while you were typing. Select the lines and ask again.");
    }
    // The agent reads the file from the disk: the person's own unsaved words go there first, so it works on what they see.
    if (doc.isDirty) await doc.save();
    const text = doc.getText(new vscode.Range(range.start.line, 0, lastLine, doc.lineAt(lastLine).range.end.character)).slice(0, 20000);
    const root = host.roots().find((r) => sameDir(doc.uri.fsPath, r)) || host.roots()[0] || "";
    const s = marks.begin(doc, { kind: "edit", label: instruction, tool: "", range: new vscode.Range(range.start.line, 0, lastLine, 0) });
    s.titleKey = `Edit ${path.basename(doc.uri.fsPath)}:${from}`;
    asked.set(s.titleKey, Date.now());
    const ok = await host.postAsk({ kind: "edit", path: doc.uri.fsPath, from, to, text, root, instruction });
    if (!ok) return marks.drop(doc.uri.fsPath);
    vscode.window.setStatusBarMessage(`✳ Editing ${lines}…`, 4000);
  }

  // ---- live edits --------------------------------------------------------------------------------------------------------

  /**
   * A file a running task names, opened here and changed before the marks saw it. Its blocks are read against the file as it was
   * before the agent: what the person settled (Keep, Undo all) if they did, else the commit the task measures from (the task's
   * `base`, which holds the person's own uncommitted work from before the run, so none of it is shown as the agent's), else git HEAD,
   * and HEAD only when the counts the task reported for the file match HEAD's diff (a file with the person's own uncommitted work in
   * it differs by more, and Undo would take their lines too: then no blocks). Never over a buffer with unsaved typing.
   */
  async function headSession(file, task, f) {
    const doc = marks.docOf(file);
    if (!doc || doc.isDirty || marks.has(file)) return;
    const kept = marks.settledText(file);
    if (kept !== undefined && kept === doc.getText()) return;
    if (kept === undefined && doc.encoding && !/^utf-?8/i.test(doc.encoding)) return;
    let was = kept !== undefined ? kept : null;
    let exact = kept !== undefined;
    if (was === null && task.base) {
      was = await gitHead(file, task.base);
      exact = was !== null;
    }
    if (was === null) {
      if (!f || typeof f.add !== "number") return;
      was = await gitHead(file);
    }
    if (was === null) return;
    const now = marks.docOf(file);
    // The person may have started typing, or marks started another way, while git answered.
    if (!now || now.isDirty || marks.has(file) || now.version !== doc.version) return;
    const hunks = hunksOf(was, now.getText());
    if (!hunks.length) return;
    if (!exact) {
      const add = hunks.reduce((n, h) => n + h.b1 - h.b0, 0);
      const del = hunks.reduce((n, h) => n + h.a1 - h.a0, 0);
      if (add !== f.add || del !== f.del) return;
    }
    const s = marks.begin(now, { kind: "agent", tool: host.TOOL[task.tool] || "An agent", title: task.title });
    s.base = was;
    marks.refresh(s, now);
  }

  function sync() {
    for (const x of running()) {
      const entries = [...(x.files || []).filter((f) => f.status !== "deleted" && f.status !== "added" && f.status !== "untracked"), ...(x.editing || []).map((p) => ({ path: p, status: "modified" }))];
      for (const f of entries) {
        const file = pathOf(f.path);
        const k = `${x.sid}\n${file}`;
        if (headTried.has(k)) continue;
        const doc = marks.docOf(file);
        // Not open yet, or the person is typing in it: looked at again when it is (a file opened, the next poll).
        if (!doc || doc.isDirty) continue;
        headTried.add(k);
        if (marks.has(file)) continue;
        void headSession(file, x, f);
      }
    }
  }

  function follow() {
    const first = !polled;
    const cfg = vscode.workspace.getConfiguration ? vscode.workspace.getConfiguration("friday") : null;
    const on = !!(cfg && cfg.get("followAgent"));
    let opened = 0;
    for (const x of running()) {
      for (const f of [...(x.editing || []).map((p) => ({ path: p, status: "modified" })), ...(x.files || [])]) {
        const k = `${x.sid}\n${f.path}`;
        if (followed.has(k)) continue;
        // Three a look at most; the rest wait for the next look rather than being passed over.
        if (!first && on && f.status !== "deleted" && opened >= 3) continue;
        followed.add(k);
        if (first || !on || f.status === "deleted") continue;
        opened++;
        // Beside, in a preview tab, focus left where it was: the agent's file appears, the person's typing is not interrupted.
        void Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.file(f.path)))
          .then((d) => vscode.window.showTextDocument(d, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true }))
          .then(undefined, () => {});
      }
    }
  }

  let item = null;
  function status() {
    if (!vscode.window.createStatusBarItem) return;
    const editor = vscode.window.activeTextEditor;
    const file = editor && editor.document.uri.scheme === "file" ? editor.document.uri.fsPath : "";
    let who = "";
    if (file) {
      const s = marks.sessions.get(file);
      const on = running();
      const inTask = on.find((x) => listed(x, file));
      if (inTask) who = host.TOOL[inTask.tool] || "An agent";
      else if (s && s.kind === "edit" && !s.seen) who = "An agent";
    }
    if (!who) return item && item.hide();
    if (!item) {
      item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
      item.command = "friday.agentStatus";
      context.subscriptions.push(item);
    }
    const follows = !!(vscode.workspace.getConfiguration && vscode.workspace.getConfiguration("friday").get("followAgent"));
    item.text = `$(sparkle) ${who} is editing`;
    item.tooltip = `${who} is changing this file. Keep or Undo each block; what you type is never written over.\nClick for more (Follow the agent is ${follows ? "on" : "off"}).`;
    item.show();
  }

  function onTasks(next) {
    tasks = next;
    for (const s of marks.all()) {
      // A change seen before Friday had said an agent runs: confirmed now.
      if (s.pending && runningTool(s.uri.fsPath, s.at)) {
        s.pending = false;
        s.tool = runningTool(s.uri.fsPath, s.at);
        const d = marks.docOf(s.uri.fsPath);
        if (d) marks.refresh(s, d);
      }
      // An edit asked for: its chat is the newest task with its title since the ask. Not started in a while, or over and changed nothing:
      // the waiting mark goes.
      if (s.kind === "edit" && !s.seen && s.titleKey) {
        const t = tasks.filter((x) => String(x.title || "").startsWith(s.titleKey) && (x.at || 0) >= s.at - 3000).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
        const age = Date.now() - s.at;
        if (!t) {
          if (age > 45000) {
            marks.drop(s.uri.fsPath);
            vscode.window.showWarningMessage("The edit didn't start. Select the lines and ask again.");
          }
        } else if (t.status === "running") {
          s.ran = true;
          if (!s.tool) s.tool = host.TOOL[t.tool] || "";
        } else if ((t.status === "done" || t.status === "pr") && ((s.ran && age > 4000) || age > 90000)) {
          marks.drop(s.uri.fsPath);
          vscode.window.setStatusBarMessage("✳ The agent made no change", 4000);
        }
      }
    }
    sync();
    follow();
    polled = true;
    status();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("friday.editWithAgent", editWithAgent),
    vscode.commands.registerCommand("friday.agentStatus", async () => {
      // The status line is a menu, not a switch: a click never changes a setting by itself.
      const on = !!vscode.workspace.getConfiguration("friday").get("followAgent");
      const file = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath;
      const items = [{ label: `Follow the agent: ${on ? "turn off" : "turn on"}`, detail: "Open each file it edits, beside this one, without taking focus", run: () => vscode.commands.executeCommand("friday.toggleFollow") }];
      if (file && marks.sessions.has(file)) items.unshift({ label: "Compare with before the agent", run: () => vscode.commands.executeCommand("friday.marks.compare", file) });
      const pick = vscode.window.showQuickPick ? await vscode.window.showQuickPick(items, { placeHolder: "Friday: the agent is editing this file" }) : null;
      if (pick) await pick.run();
    }),
    vscode.commands.registerCommand("friday.toggleFollow", async () => {
      const cfg = vscode.workspace.getConfiguration("friday");
      const on = !cfg.get("followAgent");
      await cfg.update("followAgent", on, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(on ? "✳ Following the agent: its files open beside" : "✳ Not following the agent", 3000);
      status();
    }),
  );
  if (vscode.workspace.onDidOpenTextDocument) context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(() => setTimeout(sync, 300)));
  if (vscode.window.onDidChangeActiveTextEditor) context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(status));
  return {
    onTasks,
    marks,
    /** A task this window asked for with ⌘K (its chat's title starts with the ask's): Friday's "changed a file" notice skips it. */
    owns: (task) => [...asked.keys()].some((t) => String(task.title || "").startsWith(t)),
  };
}

module.exports = { activateEdits, gitHead, sameDir };
