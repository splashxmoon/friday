"use strict";
// The Rules view in Friday's activity bar (Arun, 2026-11-19: "correct the agent once ('we use pnpm', 'no default exports') and it
// becomes a rule every tool follows. Editable in a 'Rules' view."): the repo's .friday/rules.md as a list, each rule with where it came
// from and an on/off box, plus Add rule and Open file. Every change is written to the file, so the team gets it with the repo.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rules = require("./rules.js");

const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini", opencode: "OpenCode", copilot: "Copilot" };

/**
 * The repository a folder belongs to, a worktree resolved to its main folder (the twin of repoOf in src/runner/repo-rules.ts: this is
 * plain CommonJS and can't import it). A .git FILE is a worktree's: "gitdir: /repo/.git/worktrees/name".
 */
function repoOf(start) {
  for (let d = path.resolve(start), prev = ""; d !== prev; prev = d, d = path.dirname(d)) {
    const git = path.join(d, ".git");
    if (!fs.existsSync(git)) continue;
    try {
      if (fs.statSync(git).isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(git, "utf8"));
        const g = m && m[1];
        const abs = g && /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(g) ? g : g ? path.resolve(d, g) : "";
        const main = /^(.*?)[\\/]\.git[\\/]worktrees[\\/]/.exec(abs);
        if (main && fs.existsSync(main[1])) return main[1];
      }
    } catch {
      // A .git it can't read: the folder is the repo.
    }
    return d;
  }
  return null;
}

/**
 * The folder whose rules these are: its repo's main folder; with no repo, the nearest folder up with a rules file, else the folder
 * itself. Never the home folder (its .friday is Friday's own data) nor a filesystem root: null.
 */
function rulesRoot(start) {
  const bad = (d) => d === path.parse(d).root || d === path.resolve(os.homedir());
  const repo = repoOf(start);
  if (repo) return bad(repo) ? null : repo;
  for (let d = path.resolve(start), prev = ""; d !== prev && !bad(d); prev = d, d = path.dirname(d)) if (fs.existsSync(path.join(d, ".friday", "rules.md"))) return d;
  const here = path.resolve(start);
  return bad(here) ? null : here;
}

function when(at, now = Date.now()) {
  // "YYYY-MM-DD" is the person's own day: read as a local date, and counted in calendar days (an evening save is today, not tomorrow).
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(at || "");
  if (!m) return "";
  const n = new Date(now);
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(+m[1], +m[2] - 1, +m[3])) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return at;
}

const toolsLabel = (tools) => {
  const list = String(tools || "all").split(",").map((x) => x.trim()).filter(Boolean);
  return !list.length || list.includes("all") ? "all tools" : list.map((x) => TOOL_NAMES[x] || x).join(" and ");
};

/**
 * The line beside a rule, short because the side bar is narrow: where it came from and when ("you, 2 days ago"), and which tools
 * only when it isn't all of them. The tooltip has it in full.
 */
function detail(r, now) {
  const from = r.from || "you";
  const short = from.length > 16 ? `${from.slice(0, 15)}…` : from;
  const tools = !r.tools || r.tools === "all" ? "" : `${String(r.tools).split(",").map((x) => (TOOL_NAMES[x.trim()] || x.trim()).split(" ")[0]).join(", ")} only`;
  // A long source leaves the date to the tooltip: the side bar is narrow and the source is the part worth reading.
  const day = from.length > 10 ? "" : when(r.at, now);
  return [r.on ? "" : "off", tools, [short, day].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
}

function full(r, now) {
  const from = r.from && r.from !== "you" ? `From ${r.from}` : "From you";
  return `${[from, when(r.at, now)].filter(Boolean).join(", ")} · ${toolsLabel(r.tools)}${r.on ? "" : " · off"}`;
}

function register(context, vscode) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const folders = vscode.workspace.workspaceFolders || [];
  const root = folders.map((f) => rulesRoot(f.uri.fsPath)).find(Boolean) || null;
  // The commands are in the palette whether or not a folder is open: without one they say so, instead of "command not found".
  if (!root || !vscode.window.createTreeView || !vscode.EventEmitter) {
    for (const id of ["friday.addRule", "friday.openRulesFile", "friday.editRule", "friday.removeRule", "friday.toggleRule", "friday.refreshRules"]) {
      reg(id, () => vscode.window.showInformationMessage("Open a folder in a project first: rules are kept in the project's .friday/rules.md."));
    }
    return;
  }
  const file = path.join(root, ".friday", "rules.md");
  const read = () => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  const write = (text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    refresh();
  };

  const changed = new vscode.EventEmitter();
  let text = read();
  let view;
  const refresh = () => {
    text = read();
    if (view) view.message = rules.parseRules(text).length ? "Kept in .friday/rules.md, shared with the repo." : undefined;
    changed.fire();
  };
  const boxes = vscode.TreeItemCheckboxState && vscode.TreeItemCheckboxState.Checked !== undefined;

  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren() {
      return rules.parseRules(text).map((r, index) => ({ r, index }));
    },
    getTreeItem({ r, index }) {
      const item = new vscode.TreeItem(r.text, vscode.TreeItemCollapsibleState.None);
      item.id = `rule-${index}-${r.text}`;
      item.description = detail(r);
      item.tooltip = `${r.text}\n${full(r)}`;
      item.contextValue = "friday.rule";
      if (boxes) item.checkboxState = r.on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      // An IDE without tree checkboxes: a click on the rule switches it.
      else item.command = { command: "friday.toggleRule", title: "Switch this rule", arguments: [{ r, index }] };
      if (!boxes && vscode.ThemeIcon) item.iconPath = r.on ? new vscode.ThemeIcon("pass-filled") : new vscode.ThemeIcon("circle-large-outline");
      return item;
    },
  };
  view = vscode.window.createTreeView("friday.rules", { treeDataProvider: provider, showCollapseAll: false });
  view.title = `Rules for ${path.basename(root) || root}`;
  context.subscriptions.push(view, changed);
  refresh();

  // The row a node stands for, found again in the file as it is now: the file can change between a render and a click (a chat saved
  // a rule, git pulled one), and an index from the render would flip or delete the wrong one.
  const indexOf = (node, current) => (node && node.r ? rules.parseRules(current).findIndex((x) => x.text === node.r.text) : -1);
  if (boxes && view.onDidChangeCheckboxState) {
    context.subscriptions.push(
      view.onDidChangeCheckboxState((e) => {
        let next = read();
        for (const [node, state] of e.items) {
          const i = indexOf(node, next);
          if (i >= 0) next = rules.setRuleOn(next, i, state === vscode.TreeItemCheckboxState.Checked);
        }
        write(next);
      }),
    );
  }

  reg("friday.toggleRule", (node) => {
    const now = read();
    const i = indexOf(node, now);
    if (i >= 0) write(rules.setRuleOn(now, i, !rules.parseRules(now)[i].on));
  });
  reg("friday.addRule", async (given) => {
    const body = typeof given === "string" ? given : await vscode.window.showInputBox({ prompt: "A rule every coding tool follows in this repo", placeHolder: "Use pnpm, never npm or yarn" });
    if (body && body.trim()) write(rules.addRule(read(), { text: body, from: "you" }));
  });
  reg("friday.editRule", async (node) => {
    if (indexOf(node, read()) < 0) return;
    const body = await vscode.window.showInputBox({ prompt: "Edit the rule", value: node.r.text });
    const now = read();
    const i = indexOf(node, now);
    if (body && body.trim() && i >= 0) write(rules.editRule(now, i, body));
  });
  reg("friday.removeRule", (node) => {
    const now = read();
    const i = indexOf(node, now);
    if (i >= 0) write(rules.removeRule(now, i));
  });
  reg("friday.refreshRules", refresh);
  reg("friday.openRulesFile", async () => {
    if (!fs.existsSync(file)) write(rules.HEAD);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
  });

  // The file changed under us (a chat saved a rule, someone edited it, git pulled it): the list follows. A watcher where the IDE has
  // one; a slow look only as its fallback, and not while the view is hidden.
  const watching = vscode.workspace.createFileSystemWatcher && vscode.RelativePattern;
  if (watching) {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ".friday/rules.md"));
    for (const ev of ["onDidChange", "onDidCreate", "onDidDelete"]) if (w[ev]) context.subscriptions.push(w[ev](() => text !== read() && refresh()));
    context.subscriptions.push(w);
  }
  const timer = setInterval(() => {
    if ((!view || view.visible !== false) && read() !== text) refresh();
  }, watching ? 10000 : 1500);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  return { refresh, file };
}

module.exports = { register, rulesRoot, repoOf, detail, full, when, toolsLabel };
