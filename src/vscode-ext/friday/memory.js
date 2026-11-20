"use strict";
// The Memory view in Friday's activity bar (Arun, 2026-11-20, wave 5: "Project memory per repo, shared by Code and Agents ... one
// shared brain"): what the agents learned about this repo, listed by kind, each with where it came from (a chat's title, Code or
// Agents), Edit and Forget on each, and Add. It is Friday's own project brain read through /api/vscode/memory: the same entries
// Agents' memory page shows and every coding tool is briefed from, so nothing here is kept apart.
const { execFile } = require("node:child_process");

const KIND_NAMES = { convention: "How to run and work here", decision: "Decisions", pitfall: "Quirks", correction: "Quirks", fact: "Good to know" };
const GROUP_ORDER = ["convention", "decision", "pitfall", "fact"];
const GROUP_ICONS = { convention: "terminal", decision: "git-merge", pitfall: "warning", fact: "lightbulb" };
const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini", opencode: "OpenCode", copilot: "Copilot", friday: "Friday's agent" };

/** The group an entry sits in: a correction is a quirk (a mistake agents made here), the rest by their own kind. */
const groupOf = (e) => (e.kind === "correction" ? "pitfall" : GROUP_ORDER.includes(e.kind) ? e.kind : "fact");

function ago(at, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 14 ? `${d}d ago` : `${Math.round(d / 7)}w ago`;
}

/** Where an entry came from, short: "Code · Fix the login" or "Agents · Claude Code" or "you". */
function source(e) {
  const from = e.from || {};
  const side = from.surface === "code" ? "Code" : from.surface === "agents" ? "Agents" : "";
  const who = from.tool === "person" ? "you" : from.title || from.name || TOOL_NAMES[from.tool] || "";
  return [side, who].filter(Boolean).join(" · ");
}

/** Which side of Friday it was learned in, or "you" for one written by hand without a side. */
const side = (e) => {
  const from = e.from || {};
  const where = from.surface === "code" ? "Code" : from.surface === "agents" ? "Agents" : "";
  return from.tool === "person" && !where ? "you" : where;
};

/**
 * The lesson in short lines, one row each: a tree row never wraps, and the side bar is narrow, so a long lesson drawn as one row
 * is cut and its source pushed off (Arun, 2026-11-20: "each with where it came from"). Lines break at words, and a word longer
 * than a line is cut.
 */
function wrap(text, width = 30) {
  const lines = [];
  let line = "";
  for (let word of String(text || "").split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) (lines.push(line), (line = ""));
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (line && line.length + 1 + word.length > width) (lines.push(line), (line = word));
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** The entries as the view shows them: groups in a fixed order, each its live entries pinned first then newest; none empty. */
function groups(entries) {
  const live = (entries || []).filter((e) => !e.retired);
  return GROUP_ORDER.map((kind) => ({
    kind,
    name: KIND_NAMES[kind],
    entries: live.filter((e) => groupOf(e) === kind).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at),
  })).filter((g) => g.entries.length);
}

/** The folder's git remote, or "" without one (Friday keys the repo by it, so the IDE and Agents land on one). Asked the way the runner asks, so rewrites in git's config count. */
function remoteOf(folder) {
  return new Promise((resolve) => {
    if (!folder) return resolve("");
    try {
      execFile("git", ["remote", "get-url", "origin"], { cwd: folder, timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? "" : String(out).trim()));
    } catch {
      resolve("");
    }
  });
}

function register(vscode, context, { roots }) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const base = () => (process.env.FRIDAY_URL || "").replace(/\/+$/, "");
  const token = () => process.env.FRIDAY_VSCODE_TOKEN || "";
  if (!vscode.window.createTreeView || !vscode.EventEmitter) {
    for (const id of ["friday.memory.add", "friday.memory.edit", "friday.memory.forget", "friday.memory.refresh"]) reg(id, () => vscode.window.showInformationMessage("Memory needs a newer IDE."));
    return;
  }
  const changed = new vscode.EventEmitter();
  const state = { enabled: true, repo: null, entries: [], sig: "" };
  // The remote per folder, the empty answer too (a folder with no origin is not asked again every poll); a changed workspace asks afresh.
  const remotes = new Map();
  let view;
  const folder = () => (roots() || [])[0] || "";

  const call = async (op, body) => {
    if (!base() || !token()) throw new Error("Friday is not connected to this editor. Reopen Code in Friday.");
    const f = folder();
    if (!remotes.has(f)) remotes.set(f, await remoteOf(f));
    const remote = remotes.get(f);
    const headers = { "content-type": "application/json", "x-friday-vscode": token() };
    const res = op
      ? await fetch(`${base()}/api/vscode/memory`, { method: "POST", headers, body: JSON.stringify({ folder: f, remote, op, ...body }) })
      : await fetch(`${base()}/api/vscode/memory?folder=${encodeURIComponent(f)}&remote=${encodeURIComponent(remote)}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Friday answered ${res.status}`);
    return data;
  };
  const take = (data) => {
    const sig = JSON.stringify([data.enabled, data.repo && data.repo.key, (data.entries || []).map((e) => [e.id, e.text, e.kind, e.pinned, !!e.retired])]);
    state.enabled = data.enabled !== false;
    state.repo = data.repo || null;
    state.entries = data.entries || [];
    if (view) {
      view.title = state.repo ? `Memory for ${state.repo.name}` : "Memory";
      view.message = !state.enabled ? "Learning is off in Friday: nothing new is kept, and nobody is briefed." : state.entries.some((e) => !e.retired) ? "Shared by Code and Agents, and given to every tool." : undefined;
    }
    if (sig !== state.sig) {
      state.sig = sig;
      changed.fire();
    }
  };
  const refresh = async () => {
    try {
      take(await call(null));
    } catch {
      // Friday is away a moment: the list keeps what it had.
    }
  };
  const act = async (op, body) => {
    try {
      take(await call(op, body));
      return true;
    } catch (e) {
      vscode.window.showErrorMessage(`Memory: ${e && e.message ? e.message : e}`);
      return false;
    }
  };

  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren(node) {
      if (!node) return groups(state.entries).map((g) => ({ group: g }));
      if (node.group) return node.group.entries.map((e) => ({ e }));
      return node.e ? wrap(node.e.text).map((line, i) => ({ line, i, e: node.e })) : [];
    },
    getTreeItem(node) {
      if (node.group) {
        const item = new vscode.TreeItem(node.group.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `memory-group-${node.group.kind}`;
        item.description = String(node.group.entries.length);
        item.contextValue = "friday.memory.group";
        if (vscode.ThemeIcon) item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[node.group.kind]);
        return item;
      }
      if (node.line !== undefined) {
        // One short line of the lesson, under the row that says where it came from.
        const part = new vscode.TreeItem(node.line, vscode.TreeItemCollapsibleState.None);
        part.id = `memory-${node.e.id}-${node.e.at}-${node.i}`;
        part.tooltip = node.e.text;
        part.contextValue = "friday.memory.line";
        return part;
      }
      // The row says where the lesson came from: the side and its age first, which always fit, then the chat's title or the tool, which
      // takes what room is left; the lesson itself is the lines under it, so both read without a hover.
      const e = node.e;
      const from = e.from || {};
      const who = from.tool === "person" ? "you" : from.title || from.name || TOOL_NAMES[from.tool] || "";
      const item = new vscode.TreeItem([side(e) || "you", ago(e.at)].join(" · "), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `memory-${e.id}-${e.at}`;
      item.description = [e.pinned ? "pinned" : "", side(e) === "you" ? "" : who].filter(Boolean).join(" · ");
      item.tooltip = [e.text, "", `${source(e) || "Added by hand"} · ${ago(e.at)}`, e.kind === "correction" ? "A mistake agents made here and were put right on." : ""].join("\n").trim();
      item.contextValue = "friday.memory.entry";
      if (vscode.ThemeIcon) item.iconPath = new vscode.ThemeIcon(e.pinned ? "pinned" : side(e) === "Code" ? "code" : side(e) === "Agents" ? "hubot" : "account");
      return item;
    },
  };
  view = vscode.window.createTreeView("friday.memory", { treeDataProvider: provider, showCollapseAll: false });
  view.title = "Memory";
  context.subscriptions.push(view, changed);

  reg("friday.memory.refresh", refresh);
  reg("friday.memory.add", async (given) => {
    if (!state.repo) await refresh();
    if (!state.repo) return void vscode.window.showInformationMessage("Open a folder in a project first: memory is kept for the project.");
    const text = typeof given === "string" ? given : await vscode.window.showInputBox({ prompt: `Something every agent should know about ${state.repo.name}`, placeHolder: "Run the tests with npm test; they need Redis on 6379" });
    if (!text || !text.trim()) return;
    const kinds = [
      { label: "How to run and work here", kind: "convention" },
      { label: "A decision", kind: "decision" },
      { label: "A quirk", kind: "pitfall" },
      { label: "Good to know", kind: "fact" },
    ];
    const pick = typeof given === "string" ? kinds[3] : await vscode.window.showQuickPick(kinds, { placeHolder: "What kind of thing is it?" });
    if (pick) await act("add", { text: text.trim(), kind: pick.kind });
  });
  reg("friday.memory.edit", async (node) => {
    if (!node || !node.e) return;
    const text = await vscode.window.showInputBox({ prompt: "Put it right", value: node.e.text });
    if (text && text.trim() && text.trim() !== node.e.text) await act("edit", { id: node.e.id, text: text.trim() });
  });
  reg("friday.memory.forget", async (node) => {
    if (!node || !node.e) return;
    const gone = node.e;
    if (!(await act("forget", { id: gone.id }))) return;
    // Forgetting is for good in Friday's memory, so the notice carries a way back (the same lesson, put in again).
    const answer = await vscode.window.showInformationMessage("Forgot it. Agents won't be told it any more. Undo puts it back as your own note.", "Undo");
    if (answer === "Undo") await act("add", { text: gone.text, kind: gone.kind === "correction" ? "pitfall" : gone.kind });
  });

  // The list follows what agents learn while the person works: a slow look, not while the view is hidden.
  void refresh();
  const timer = setInterval(() => {
    if (!view || view.visible !== false) void refresh();
  }, 6000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  if (vscode.workspace && vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => (remotes.clear(), void refresh())));
  if (view.onDidChangeVisibility) context.subscriptions.push(view.onDidChangeVisibility((e) => e.visible && void refresh()));
  return { refresh, state };
}

module.exports = { register, groups, wrap, groupOf, source, side, ago, remoteOf, KIND_NAMES };
