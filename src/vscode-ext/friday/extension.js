"use strict";
// Friday's extension for its own VS Code: Ask an agent (Cmd/Ctrl+L) and files opened from Friday.
// Plain CommonJS, no dependencies beyond node built-ins and vscode.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { activateEdits } = require("./edits");
const { whereLabel, contextOf, iconOf, ownTasks, sidOf, sameDir } = require("./board-label.js");
const { createQuietNotes, summaryText } = require("./quiet.js");
const { laterRoot, laterGroupItem, laterTaskItem, ranIcon } = require("./later.js");

const MAX_TEXT = 20000;
/** The terminal helper, once activated: watchTerminals hands it every failed command. */
let termhelp = null;

function relativePath(root, file) {
  if (!root) return file;
  const rel = path.relative(root, file);
  return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file).split(path.sep).join("/");
}

/** The ask for the active editor: its selection, or the current line when nothing is selected. */
function buildAsk(editor) {
  const doc = editor.document;
  const folder = vscode.workspace.getWorkspaceFolder ? vscode.workspace.getWorkspaceFolder(doc.uri) : undefined;
  const root = folder ? folder.uri.fsPath : (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || "";
  const sel = editor.selection;
  const range = sel && !sel.isEmpty ? sel : doc.lineAt(sel ? sel.active.line : 0).range;
  const text = doc.getText(range).slice(0, MAX_TEXT);
  return { path: relativePath(root, doc.uri.fsPath), from: range.start.line + 1, to: range.end.line + 1, text, root };
}

async function askAgent() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (!base || !token) {
    vscode.window.showWarningMessage("Friday is not connected to this editor. Reopen Code in Friday.");
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-friday-vscode": token },
      body: JSON.stringify(buildAsk(editor)),
    });
    if (!res.ok) throw new Error(`Friday answered ${res.status}`);
    vscode.window.setStatusBarMessage("Sent to Friday's agent panel", 2500);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not reach Friday: ${e && e.message ? e.message : e}`);
  }
}

/**
 * Fix with an agent, wherever something broke (Arun, 2026-11-19, the engineer loop: "Fix with Claude Code" on a red squiggle, a
 * Fix chip on a failing command). Sent to Friday as an ask with the problem in it: Friday starts a chat in its column that
 * reproduces it, finds the cause, fixes it and adds a test (kind "fix"), or explains it without changing anything ("explain").
 */
async function postAsk(body) {
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (!base || !token) {
    vscode.window.showWarningMessage("Friday is not connected to this editor. Reopen Code in Friday.");
    return false;
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-friday-vscode": token },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Friday answered ${res.status}`);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Could not reach Friday: ${e && e.message ? e.message : e}`);
    return false;
  }
}

/** A problem the editor shows (a squiggle, a Problems row), as an ask: the file, its lines, the code there and the message. */
function problemAsk(kind, uri, diag) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  const from = Math.max(0, diag.range.start.line - 3);
  const to = Math.min((doc ? doc.lineCount : diag.range.end.line + 4) - 1, diag.range.end.line + 3);
  const text = doc ? doc.getText(new vscode.Range(from, 0, to, Number.MAX_SAFE_INTEGER)) : "";
  const code = diag.code && typeof diag.code === "object" ? diag.code.value : diag.code;
  const source = [diag.source, code !== undefined && code !== "" ? `(${code})` : ""].filter(Boolean).join("");
  const root = workspaceRoots().find((r) => uri.fsPath.startsWith(r)) || workspaceRoots()[0] || "";
  return { kind, path: uri.fsPath, from: from + 1, to: to + 1, text, root, problem: diag.message, source: source || "the editor", line: diag.range.start.line + 1 };
}

class FixActions {
  provideCodeActions(document, _range, context) {
    const out = [];
    for (const diag of context.diagnostics) {
      if (diag.severity > vscode.DiagnosticSeverity.Warning) continue;
      const fix = new vscode.CodeAction("Fix with Friday", vscode.CodeActionKind.QuickFix);
      fix.command = { command: "friday.fixProblem", title: "Fix with Friday", arguments: ["fix", document.uri, diag] };
      fix.diagnostics = [diag];
      const explain = new vscode.CodeAction("Explain this error with Friday", vscode.CodeActionKind.QuickFix);
      explain.command = { command: "friday.fixProblem", title: "Explain with Friday", arguments: ["explain", document.uri, diag] };
      explain.diagnostics = [diag];
      out.push(fix, explain);
      if (out.length >= 4) break;
    }
    return out;
  }
}

/**
 * A command in the terminal that failed: its output, read as it ran (shell integration), offered to Friday once it ends with an
 * error. Only the last of it is kept, which is where the failure is said.
 */
function watchTerminals(context) {
  if (!vscode.window.onDidStartTerminalShellExecution || !vscode.window.onDidEndTerminalShellExecution) return;
  const outputs = new WeakMap();
  // Commands that passed before (Arun, 2026-11-19, wave 2: a command that used to pass and fails now is offered "Find what broke"):
  // kept per folder so it holds across reloads (bisect.js passedMemory: hashes, the last 60; the old key held the lines as typed).
  const passed = require("./bisect.js").passedMemory(context.workspaceState ? context.workspaceState.get("friday.passedHashes", []) : []);
  if (context.workspaceState && context.workspaceState.get("friday.passed")) void context.workspaceState.update("friday.passed", undefined);
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((e) => {
      const kept = { text: "" };
      outputs.set(e.execution, kept);
      void (async () => {
        try {
          for await (const chunk of e.execution.read()) {
            kept.text = (kept.text + chunk).slice(-16000);
          }
        } catch {
          // Output not readable: the failure is offered with the command alone.
        }
      })();
    }),
    vscode.window.onDidEndTerminalShellExecution(async (e) => {
      const line = (e.execution.commandLine && e.execution.commandLine.value) || "";
      if (e.exitCode === 0 && line) {
        passed.remember(line);
        if (context.workspaceState) void context.workspaceState.update("friday.passedHashes", passed.list());
      }
      if (!e.exitCode) return;
      const cmd = (e.execution.commandLine && e.execution.commandLine.value) || "the command";
      // A command stopped by hand (Ctrl+C) isn't a failure to fix.
      if (e.exitCode === 130) return;
      const output = clean((outputs.get(e.execution) || { text: "" }).text).slice(-6000);
      const short = cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd;
      // "Find what broke" only for one that worked before: it has a past to search.
      const worked = !!line && passed.worked(line);
      // The terminal helper keeps the failure so "Explain" (and the palette's) answers it in a quick pick (termhelp.js).
      const cwd = (e.execution.cwd && e.execution.cwd.fsPath) || workspaceRoots()[0] || "";
      // Built once: the notification's own button explains this failure, not whichever failed last.
      const failure = { cmd, output, exit: e.exitCode, cwd, terminal: e.terminal, root: workspaceRoots()[0] || cwd };
      if (termhelp) termhelp.failed(failure);
      const pick = await vscode.window.showWarningMessage(`✳ ${short} failed (exit ${e.exitCode})`, "Fix it", "Explain", ...(worked ? ["Find what broke"] : []));
      if (!pick) return;
      if (pick === "Explain" && termhelp) return void termhelp.explain(failure);
      if (pick === "Find what broke") {
        await postAsk(require("./bisect.js").bisectAsk(workspaceRoots()[0] || cwd, "", { cmd, output, cwd }));
        return;
      }
      await postAsk({ kind: pick === "Fix it" ? "fix" : "explain", path: "", from: 1, to: 1, text: "", root: workspaceRoots()[0] || cwd, problem: output || `exit ${e.exitCode}`, source: `the terminal · ${cmd}`, cwd });
    }),
  );
}
/** Terminal output without its colours and cursor moves. */
function clean(s) {
  return String(s).replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "").replace(/\r(?!\n)/g, "");
}

/**
 * The task board (Arun, 2026-11-19, the engineer loop: "every task at once, in Code"): Code's chats, by where they stand: waiting
 * on you first, then running, pull requests open, done. Read from Friday (/api/vscode/tasks) every few seconds while the view
 * shows, and for the status bar's line always, a light look. A task picked opens its chat in Friday's column.
 */
const GROUPS = [
  { id: "waiting", label: "Waiting on you", icon: "circle-filled", color: "charts.yellow" },
  { id: "running", label: "Running", icon: "loading~spin", color: "charts.blue" },
  { id: "pr", label: "PR ready", icon: "git-pull-request", color: "charts.green" },
  { id: "done", label: "Done", icon: "check", color: "descriptionForeground" },
];
function ago(ms) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
const TOOL = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Antigravity", opencode: "OpenCode" };
class TaskBoard {
  constructor() {
    this.tasks = [];
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }
  async refresh(force) {
    const base = process.env.FRIDAY_URL;
    const token = process.env.FRIDAY_VSCODE_TOKEN;
    if (!base || !token) return this.tasks;
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/tasks`, { headers: { "x-friday-vscode": token } });
      if (!res.ok) return this.tasks;
      const body = await res.json();
      const next = Array.isArray(body.tasks) ? body.tasks : [];
      this.agentsWaiting = typeof body.agentsWaiting === "number" ? body.agentsWaiting : 0;
      // Tasks queued with Run later, waiting for their time (later.js).
      this.later = Array.isArray(body.later) ? body.later : [];
      const sig = JSON.stringify([next.map((x) => [x.sid, x.status, x.detail, x.title, x.where, !!x.linked, x.folder, x.overnight, x.ran]), this.later.map((x) => [x.id, x.at, x.title])]);
      // The newest list is always kept (the files and edits a running task names change while its words don't: Keep / Undo reads
      // them); the tree is redrawn only when what it shows changed.
      this.tasks = next;
      // `force`: the view was just shown, and what it drew while hidden may be the empty welcome (a tree that rendered nothing is not redrawn by an unchanged list).
      if (sig !== this.sig || force) {
        this.sig = sig;
        this.changed.fire();
      }
    } catch {
      // Friday is away a moment: the board keeps what it had.
    }
    return this.tasks;
  }
  getChildren(el) {
    if (!el) return [...laterRoot(this.later || []), ...GROUPS.map((g) => ({ group: g, items: this.tasks.filter((x) => x.status === g.id) })).filter((g) => g.items.length)];
    if (el.later) return el.items.map((x) => ({ laterTask: x }));
    // Newest first across Code's chats and Agents' sessions, so a long run of finished Code chats never hides this folder's Agents ones.
    const rows = [...el.items].sort((a, b) => (b.since || b.at || 0) - (a.since || a.at || 0));
    return rows.slice(0, el.group.id === "done" ? 10 : 50).map((task) => ({ task }));
  }
  getTreeItem(el) {
    if (el.later) return laterGroupItem(vscode, el);
    if (el.laterTask) return laterTaskItem(vscode, el.laterTask);
    if (el.group) {
      const item = new vscode.TreeItem(el.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(el.items.length);
      item.iconPath = new vscode.ThemeIcon(el.group.icon, new vscode.ThemeColor(el.group.color));
      item.id = `group:${el.group.id}`;
      return item;
    }
    const x = el.task;
    const item = new vscode.TreeItem(x.title || "Untitled", vscode.TreeItemCollapsibleState.None);
    // Each row says where it lives (board-label.js): "Code", "Agents", or "Agents · open in Code" for a linked tab.
    // The description is cut first when the title is long, so where a row lives also rides on its icon, which never is: a chat
    // bubble for Code, a person for Agents, a link for an Agents session open as a tab in Code. A row from another folder keeps
    // its folder's name. One Run later started says when it ran (later.js), with its own mark.
    item.iconPath = x.overnight ? ranIcon(vscode, x) : new vscode.ThemeIcon(iconOf(x));
    const away = x.folder && !sameDir(x.folder, workspaceRoots()[0] || "") ? String(x.folder).split(/[\\/]+/).filter(Boolean).pop() : "";
    const ran = x.overnight ? x.ran || "Ran overnight" : "";
    item.description = [whereLabel(x), ran, away, x.detail, ago(x.since || x.at)].filter(Boolean).join(" · ");
    item.contextValue = contextOf(x);
    item.tooltip = new vscode.MarkdownString(`**${(x.title || "Untitled").replace(/[*_`]/g, "")}**  \n${[whereLabel(x), ran, TOOL[x.tool] || "", x.detail, x.folder].filter(Boolean).join(" · ").replace(/[*_`]/g, "")}`);
    item.command = { command: "friday.openTask", title: "Open task", arguments: [x.sid] };
    item.id = `task:${x.sid}`;
    return item;
  }
}
/**
 * What the agents changed, seen in the IDE (Arun, 2026-11-19: "it made some changes but idk if it is registering properly on the
 * ide"): each file a task's agent changed and hasn't committed carries a ✳ in the Explorer and on its tab, saying which agent and
 * which chat; and when a task changes more files, a notice says so, with Review.
 */
class AgentMarks {
  constructor() {
    this.byPath = new Map();
    this.changed = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this.changed.event;
  }
  set(tasks) {
    const next = new Map();
    for (const x of tasks) {
      for (const f of x.files || []) {
        const key = vscode.Uri.file(f.path).fsPath;
        const had = next.get(key);
        next.set(key, had ? { ...had, more: true } : { tool: TOOL[x.tool] || "An agent", title: x.title || "a chat", status: f.status, add: f.add, del: f.del });
      }
    }
    const touched = new Set([...this.byPath.keys(), ...next.keys()]);
    const sig = JSON.stringify([...next.entries()]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.byPath = next;
    this.changed.fire([...touched].map((p) => vscode.Uri.file(p)));
  }
  provideFileDecoration(uri) {
    const m = this.byPath.get(uri.fsPath);
    if (!m) return undefined;
    const lines = m.status === "deleted" ? "deleted" : `+${m.add || 0} −${m.del || 0}`;
    const d = new vscode.FileDecoration("✳", `${m.tool} changed this in “${m.title}”${m.more ? " and another chat" : ""} · ${lines}`, new vscode.ThemeColor("charts.orange"));
    d.propagate = true;
    return d;
  }
}

function watchTasks(context) {
  // Keep / Undo on what the agents wrote, in the editor (edits.js, marks.js).
  let edits = null;
  if (vscode.languages && vscode.languages.registerCodeLensProvider && vscode.WorkspaceEdit) {
    edits = activateEdits(context, vscode, { postAsk, roots: workspaceRoots, TOOL, poll: () => void tick() });
  }
  const board = new TaskBoard();
  const marks = new AgentMarks();
  if (vscode.window.registerFileDecorationProvider) context.subscriptions.push(vscode.window.registerFileDecorationProvider(marks));
  // How many files each task had changed when last looked at: more than that is said once, with Review.
  const seen = new Map();
  let first = true;
  // While you type, the notice waits for a pause and comes as one (quiet.js; Arun, 2026-11-19: "Friday holds its pings").
  const quietOn = () => {
    try {
      return vscode.workspace.getConfiguration("friday").get("quietWhileTyping") !== false;
    } catch {
      return true;
    }
  };
  const quiet = createQuietNotes({
    on: quietOn,
    show: (list) => {
      const one = list.length === 1 ? list[0] : null;
      void vscode.window.showInformationMessage(summaryText(list), "Review", ...(one ? ["Open the chat"] : [])).then((pick) => {
        if (pick === "Review") void reviewChanges();
        else if (pick === "Open the chat" && one) sendKey("task", { sid: one.sid });
      });
    },
  });
  context.subscriptions.push(quiet);
  // Only a real edit by you counts: in the editor you are looking at, with the window focused, and the document changed (dirty) by
  // typing, not an agent's file written to disk and reloaded under it.
  if (vscode.workspace.onDidChangeTextDocument) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const ed = vscode.window.activeTextEditor;
        if (!ed || e.document !== ed.document || !e.contentChanges || !e.contentChanges.length || !e.document.isDirty) return;
        if (vscode.window.state && vscode.window.state.focused === false) return;
        quiet.typed();
      }),
    );
  }
  if (vscode.workspace.onDidChangeConfiguration) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("friday.quietWhileTyping") && !quietOn() && quiet.release()));
  }
  const announce = (tasks) => {
    for (const x of tasks) {
      const n = (x.files || []).length;
      const was = seen.get(x.sid);
      seen.set(x.sid, n);
      if (first || was === undefined || n <= was) continue;
      // A ⌘K edit is asked for in place and shown there, with Keep / Undo: no notice for its chat (edits.js owns).
      if (edits && edits.owns(x)) continue;
      const tool = TOOL[x.tool] || "The agent";
      const names = (x.files || []).slice(0, 2).map((f) => String(f.path).split(/[\\/]/).pop()).join(", ");
      const text = `✳ ${tool} changed ${n} file${n === 1 ? "" : "s"} in “${x.title || "a chat"}”: ${names}${n > 2 ? "…" : ""}`;
      if (quiet.hold({ sid: x.sid, text })) continue;
      void vscode.window
        .showInformationMessage(text, "Review", "Open the chat")
        .then((pick) => {
          if (pick === "Review") void reviewChanges();
          else if (pick === "Open the chat") sendKey("task", { sid: x.sid });
        });
    }
    first = false;
  };
  const view = vscode.window.createTreeView("friday.tasks", { treeDataProvider: board, showCollapseAll: false });
  // What waits in Agents, in the IDE's own status bar: Friday's chat lies over the IDE's right side bar, so this status bar runs under
  // it and is the window's one footer (Arun, 2026-11-20). Code's own counts aren't said there (Arun, 2026-11-20: "get rid of this"
  // of "● 1 running"): the Tasks view's badge has what waits on you.
  const inAgents = vscode.window.createStatusBarItem && vscode.window.createStatusBarItem("friday.agentsWaiting", vscode.StatusBarAlignment.Right, 999);
  if (inAgents) {
    inAgents.name = "Friday: waiting in Agents";
    inAgents.command = "friday.openNeeds";
    inAgents.tooltip = "Open Needs you in Agents";
    context.subscriptions.push(inAgents);
  }
  const sayLine = () => {
    if (inAgents) {
      const k = board.agentsWaiting || 0;
      if (k) {
        inAgents.text = `${k} waiting in Agents`;
        inAgents.show();
      } else inAgents.hide();
    }
  };
  const paint = (all) => {
    // An Agents session in this folder lives in the list only: its files aren't marked here, nor announced (board-label.js).
    const tasks = ownTasks(all);
    sayLine(tasks);
    marks.set(tasks);
    if (edits) edits.onTasks(tasks);
    announce(tasks);
    const waiting = tasks.filter((x) => x.status === "waiting").length;
    view.badge = waiting ? { value: waiting, tooltip: `${waiting} waiting on you` } : undefined;
  };
  let timer;
  const tick = async (force) => {
    clearTimeout(timer);
    paint(await board.refresh(force === true));
    timer = setTimeout(tick, view.visible ? 3000 : 4000);
  };
  void tick();
  context.subscriptions.push(
    view,
    { dispose: () => clearTimeout(timer) },
    view.onDidChangeVisibility(() => view.visible && void tick(true)),
    vscode.commands.registerCommand("friday.refreshTasks", () => void tick()),
    vscode.commands.registerCommand("friday.openTask", (arg) => sidOf(arg) && sendKey("task", { sid: sidOf(arg) })),
    // An Agents session, as a linked tab in Code's column (the same as "Open in Code" on the session in Agents).
    vscode.commands.registerCommand("friday.openTaskInCode", (arg) => sidOf(arg) && sendKey("task", { sid: sidOf(arg), inCode: true })),
    vscode.commands.registerCommand("friday.newTask", () => sendKey("new")),
    vscode.commands.registerCommand("friday.showTasks", () => vscode.commands.executeCommand("workbench.view.extension.friday")),
    vscode.commands.registerCommand("friday.openNeeds", () => sendKey("needs")),
    // The right side bar's "Agent" view is the room Friday's chat lies over: empty, the chat draws there (VsCodeView.tsx).
    ...(vscode.window.registerTreeDataProvider ? [vscode.window.registerTreeDataProvider("friday.chatSpace", { getChildren: () => [], getTreeItem: (x) => x })] : []),
  );
}

/**
 * Review the branch (Arun, 2026-11-19, the engineer loop: "you read the change in the IDE's own diff"): every file it changed
 * against the branch it came from (origin's default, else main or master), committed or not, in one multi-file diff.
 */
let prReviewApi = null;
async function reviewChanges(arg) {
  const race = require("./race.js");
  // Asked for a pull request's copy: its review comments are there for it (pr-review.js looks at this window's folders).
  if (arg && prReviewApi) void prReviewApi.check();
  const git = vscode.extensions.getExtension("vscode.git");
  if (!git) return vscode.window.showWarningMessage("Git isn't available in this window.");
  const api = (git.isActive ? git.exports : await git.activate()).getAPI(1);
  // A racer's checkout when the chat column names one (race.js), else the folder's.
  const repo = await race.repoFor(vscode, api, arg);
  if (!repo) return vscode.window.showInformationMessage(arg ? "The IDE couldn't open that copy's changes." : "This folder isn't a git repository.");
  // What the agent just wrote may not be in git's view yet: read the folder again first.
  await repo.status().catch(() => {});
  const head = repo.state.HEAD && repo.state.HEAD.name;
  // The session's own pull request (Arun, 2026-11-20: "Review in the IDE from anywhere"): its branch is what the folder is on. When it
  // has moved off it, the diff is the folder's own and the tab doesn't wear the pull request's name.
  const want = race.reviewArgOf(arg);
  if (want && want.head && head && want.head !== head) {
    vscode.window.showWarningMessage(`This folder is on ${head}, not the pull request's branch ${want.head}: showing the changes of ${head}.`);
    arg = { ...arg, label: "" };
  }
  let base = "";
  for (const b of race.baseCandidates(arg)) {
    try {
      const mb = await repo.getMergeBase(b, "HEAD");
      if (mb) {
        base = mb;
        break;
      }
    } catch {
      // Not a branch here: the next.
    }
  }
  if (!base && want && want.strict) return vscode.window.showWarningMessage(`${want.base} isn't in this folder yet, so the pull request's changes can't be shown against it. Fetch it (git fetch) and try again.`);
  if (!base) return vscode.window.showInformationMessage("No base branch found to compare with.");
  const committed = await repo.diffBetween(base, "HEAD").catch(() => []);
  const seen = new Set();
  const rows = [];
  for (const c of [...committed, ...repo.state.workingTreeChanges, ...repo.state.indexChanges]) {
    const uri = c.uri;
    if (seen.has(uri.fsPath)) continue;
    seen.add(uri.fsPath);
    // A file the change adds has nothing on the base side, and one it deletes nothing on the other: the diff shows it as all new or all
    // gone (race.js sideOf), where a git: address that does not exist was an error in the editor.
    const side = require("./race.js").sideOf(c.status);
    // A pull request's copy leaves its own .vscode out of the folder (src/runner/git.ts): that side is read from the commit instead.
    const there = side === "deleted" ? undefined : arg && !fs.existsSync(uri.fsPath) ? api.toGitUri(uri, "HEAD") : uri;
    rows.push([uri, side === "added" ? undefined : api.toGitUri(c.originalUri || uri, base), there]);
  }
  if (!rows.length) return vscode.window.showInformationMessage(`No changes on ${head || "this branch"} yet.`);
  await vscode.commands.executeCommand("vscode.changes", race.reviewTitle(arg, head, rows.length), rows);
}

/** A Friday key pressed while focus is inside VS Code: the page cannot see it from the frame, so it goes over the local server. */
function sendKey(key, extra) {
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (!base || !token) return;
  fetch(`${base.replace(/\/+$/, "")}/api/vscode/key`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-friday-vscode": token },
    body: JSON.stringify({ key, ...extra }),
  }).catch(() => {});
}

/** A folder's name in the bridge: the same as the runner's rootKey (src/runner/vscode.ts). */
function rootKey(root) {
  let r = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:/.test(r) || String(root).startsWith("\\\\")) r = r.toLowerCase();
  return crypto.createHash("sha1").update(r).digest("hex").slice(0, 12);
}

/** Whether a request's folder is one this window has open (every VS Code window of Friday's shares the bridge). No folder named: any. */
function isForThisWindow(root, folders) {
  if (!root) return true;
  const want = rootKey(root);
  return folders.some((f) => rootKey(f) === want);
}

function workspaceRoots() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

async function openRequest(file) {
  let req;
  try {
    const mtime = fs.statSync(file).mtimeMs;
    // One write is opened once; writing the same file again (a new mtime) opens it again.
    if (mtime === openRequest.last) return;
    req = JSON.parse(fs.readFileSync(file, "utf8"));
    openRequest.last = mtime;
  } catch {
    return;
  }
  if (!req || typeof req.path !== "string" || !req.path) return;
  if (!isForThisWindow(req.root, workspaceRoots())) return;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(req.path));
    const line = Math.max(0, (Number(req.line) || 1) - 1);
    const pos = new vscode.Position(line, 0);
    // A cited range (Ask the codebase) is selected whole, so the lines it means are the ones lit.
    const last = Number(req.end) > line + 1 ? Number(req.end) - 1 : 0;
    const to = last && last < doc.lineCount ? doc.lineAt(last).range.end : pos;
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, to), preview: false, ...(req.side === true ? { viewColumn: vscode.ViewColumn.Beside } : {}) });
  } catch {
    // A file that is gone or unreadable is simply not opened.
  }
}

/**
 * A layout button or the search pill in Friday's window bar (bridge/command.json, src/runner/vscode.ts vscodeCommand): VS Code's
 * own command for it, run once, only for a request a few seconds old (not one left from before this window started), and only
 * these three.
 */
// What the runner may ask for (src/runner/vscode.ts vscodeCommand checks each against its exact list: the window bar's buttons
// and the Mac menu bar's VS Code menus, src/vscode-menu.ts): here, only VS Code's own commands, by their families.
const ALLOWED = /^(?:(?:workbench|editor|debug|actions|welcome)\.[\w.]+|undo|redo|copyRelativeFilePath|friday\.reviewChanges|friday\.openCommit|friday\.showStack|friday\.askCodebase|friday\.findBreak|friday\.refactorAcross|friday\.searchSymbols|friday\.searchText)$/;
const COMMANDS = { has: (c) => typeof c === "string" && ALLOWED.test(c) };
async function commandRequest(file) {
  let req;
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime === commandRequest.last) return;
    req = JSON.parse(fs.readFileSync(file, "utf8"));
    commandRequest.last = mtime;
  } catch {
    return;
  }
  if (!req || !COMMANDS.has(req.command) || !(Date.now() - Number(req.at) < 5000)) return;
  if (req.n === commandRequest.n) return;
  commandRequest.n = req.n;
  if (!isForThisWindow(req.root, workspaceRoots())) return;
  try {
    // Review changes on a racer's checkout (race.js) and "open a commit" (a hash only) are the commands that take an argument.
    if (req.command === "friday.reviewChanges" && req.review) await reviewChanges(req.review);
    else if (req.command === "friday.openCommit") await vscode.commands.executeCommand(req.command, req.arg);
    else if (req.command === "friday.searchSymbols" || req.command === "friday.searchText") await require("./search.js")[req.command === "friday.searchText" ? "text" : "symbols"](vscode, req.arg);
    else await vscode.commands.executeCommand(req.command);
  } catch {
    // Nothing to show or toggle: the button did nothing.
  }
}

/** Friday's current theme, written by the runner on start and when it changes (bridge/theme.json): VS Code follows it, not only the operating system. */
const THEMES = { dark: "Friday Dark", light: "Friday Light" };
async function applyTheme(file) {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime === applyTheme.last) return;
    const req = JSON.parse(fs.readFileSync(file, "utf8"));
    applyTheme.last = mtime;
    const want = THEMES[req && req.theme];
    if (!want) return;
    const cfg = vscode.workspace.getConfiguration("workbench");
    if (cfg.get("colorTheme") !== want) await cfg.update("colorTheme", want, vscode.ConfigurationTarget.Global);
  } catch {
    // No theme sent yet, or not readable: the operating system's choice stands.
  }
}

/** The quiet-while-typing setting, told to Friday's page (the skin tells it each key: vscode-skin.ts), now and whenever it changes. */
function tellQuiet() {
  try {
    sendKey("focus", { quiet: vscode.workspace.getConfiguration("friday").get("quietWhileTyping") !== false });
  } catch {
    // An IDE with no settings to read: the default (quiet while typing) stands.
  }
}

function activate(context) {
  if (vscode.workspace.onDidChangeConfiguration) {
    tellQuiet();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("friday.quietWhileTyping") && tellQuiet()));
  }
  context.subscriptions.push(vscode.commands.registerCommand("friday.askAgent", askAgent));
  context.subscriptions.push(vscode.commands.registerCommand("friday.switchMode", () => sendKey("mode")));
  context.subscriptions.push(vscode.commands.registerCommand("friday.toggleAgent", () => sendKey("agent")));
  context.subscriptions.push(
    vscode.commands.registerCommand("friday.fixProblem", (kind, uri, diag) => postAsk(problemAsk(kind === "explain" ? "explain" : "fix", uri, diag))),
  );
  // Each part only where the IDE has what it needs (an older build, or a test's stand-in, may not).
  if (vscode.languages && vscode.languages.registerCodeActionsProvider && vscode.CodeActionKind) {
    for (const scheme of ["file", "vscode-remote"]) {
      context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ scheme }, new FixActions(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
    }
  }
  // Ask the codebase: a question answered with the lines it cites (askcode.js).
  require("./askcode.js").register(vscode, context, postAsk, (uri) => workspaceRoots().find((r) => uri.fsPath.startsWith(r)) || workspaceRoots()[0] || "", workspaceRoots);
  // Explain · Test · Fix · Refactor above each function (lens.js).
  const lensApi = require("./lens.js").register(vscode, context, postAsk, (uri) => workspaceRoots().find((r) => uri.fsPath.startsWith(r)) || workspaceRoots()[0] || "");
  // "✳ Write message" in the Source Control box: the staged diff and the repo's style, written by the person's coding tool (commitmsg.js).
  require("./commitmsg.js").register(vscode, context, workspaceRoots);
  // Refactor across the codebase: plan every file first, then do them all (refactor.js).
  require("./refactor.js").register(vscode, context, postAsk, (uri) => workspaceRoots().find((r) => uri.fsPath.startsWith(r)) || workspaceRoots()[0] || "");
  // The terminal helper (Arun, 2026-11-20): "Friday: Write a command" and a quick "Explain" on a failed command (termhelp.js).
  termhelp = require("./termhelp.js").register(vscode, context, workspaceRoots, postAsk);
  watchTerminals(context);
  // A stop in the debugger, offered to the agent with its stack and variables (debug.js).
  require("./debug.js").register(vscode, context, postAsk, workspaceRoots);
  // Find what broke: the command (palette, source control's title) and a commit's diff (bisect.js).
  require("./bisect.js").register(context, vscode, postAsk, () => workspaceRoots()[0] || "");
  if (vscode.window.createTreeView && vscode.EventEmitter) watchTasks(context);
  require("./rules-view.js").register(context, vscode);
  // The Memory view: the repo's project brain, shared with Agents (memory.js).
  require("./memory.js").register(vscode, context, { roots: workspaceRoots });
  // Stacked pull requests: the Stack view and Restack, a conflict handed to the agent (stack-view.js).
  require("./stack-view.js").register(context, vscode, { postAsk, roots: workspaceRoots });
  // Tests where coverage is missing: the report's uncovered lines, and asks to write tests for them (cover.js).
  require("./cover.js").register(vscode, context, { postAsk, roots: workspaceRoots, rootOf: (uri) => workspaceRoots().find((r) => uri.fsPath.startsWith(r)) || workspaceRoots()[0] || "", relative: relativePath, lens: lensApi });
  // TODOs become tasks: the TODO comments in the folder, listed, and handed to an agent in a click (todos.js).
  require("./todos.js").register(vscode, context, { postAsk, roots: workspaceRoots, rootOf: (uri) => workspaceRoots().find((r) => uri.fsPath.startsWith(r)) || workspaceRoots()[0] || "" });
  context.subscriptions.push(vscode.commands.registerCommand("friday.reviewChanges", (arg) => void reviewChanges(arg)));
  require("./review.js").watchReview(context, vscode);
  // A teammate's pull request, when this window is open on the copy Friday checked it out in: its comments, drafts and Submit review (pr-review.js).
  prReviewApi = require("./pr-review.js").register(vscode, context, { roots: workspaceRoots });
  // The pull request's checks in the status bar, a failed one at the line it names, and Fix with Friday on them (ci.js).
  require("./ci.js").register(vscode, context, { postAsk, roots: workspaceRoots });
  // The coding tool's remaining window, in the status bar only when it is low (usage.js).
  require("./usage.js").register(vscode, context, { roots: workspaceRoots });
  // Which files have unsaved edits, for a rewind's confirm (dirty.js).
  require("./dirty.js").register(vscode, context, { roots: workspaceRoots, relative: relativePath, post: require("./dirty.js").poster(process.env) });
  // Dev servers Friday keeps for the folder: a status item and a list with Start, Stop, Restart, Open and logs (servers.js).
  require("./servers.js").register(vscode, context, { roots: workspaceRoots });
  // Everything Friday can do from here, in one quick pick: a key and the ✳ in the status bar (palette.js).
  require("./palette.js").register(vscode, context, { roots: workspaceRoots, sendKey });
  const bridge = process.env.FRIDAY_VSCODE_BRIDGE;
  if (!bridge) return;
  const file = path.join(bridge, "open.json");
  try {
    fs.mkdirSync(bridge, { recursive: true });
  } catch {
    // The runner makes it; a watcher below still works once it exists.
  }
  // Told by the folder's own change events (no polling while idle); a slow poll stands behind it for file systems that never
  // say, and for the file being replaced by a rename.
  const themeFile = path.join(bridge, "theme.json");
  const commandFile = path.join(bridge, "command.json");
  const onChange = () => {
    void openRequest(file);
    void applyTheme(themeFile);
    void commandRequest(commandFile);
  };
  try {
    const w = fs.watch(bridge, { persistent: false }, onChange);
    w.on("error", () => {});
    context.subscriptions.push({ dispose: () => w.close() });
  } catch {
    // The slow poll below covers it.
  }
  fs.watchFile(file, { interval: 3000, persistent: false }, onChange);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(file, onChange) });
  // Started and listening: one mark per open folder, carrying this start's token, which the runner reads to say "ready" and the page
  // lifts its cover on (a window drawn is not a window that loaded).
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (token) {
    // An empty window (no folder yet) marks "" the same way, which is what Friday waits on then.
    const roots = workspaceRoots();
    for (const root of roots.length ? roots : [""]) {
      try {
        fs.writeFileSync(path.join(bridge, `ready-${rootKey(root)}.json`), JSON.stringify({ token, at: Date.now() }));
      } catch {
        // The page's own wait ends by itself.
      }
    }
  }
  void applyTheme(themeFile);
  // The folder this window opened, told to Friday: one opened from inside VS Code (its own Open Folder, a recent) becomes Code's
  // folder there too, so the agent column and the window bar follow it.
  const opened = workspaceRoots()[0];
  if (opened) sendKey("root", { root: opened });
  // A request written in the last few seconds, while this window was still starting.
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < 10000) setTimeout(onChange, 300);
  } catch {
    // No request yet.
  }
}

function deactivate() {}

module.exports = { activate, deactivate, buildAsk, rootKey, isForThisWindow, TaskBoard };
