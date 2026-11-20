"use strict";
// Friday's palette in the IDE (Arun, 2026-11-19, wave 4: "Friday command palette: one key for every Friday action from the IDE: new
// chat, hand off, review, race, switch tool, open a session, search"). One quick pick, opened by a key or the ✳ in the status bar,
// listing what Friday can do from here. An action is an IDE command (run here) or a key "action" sent to Friday's page, which
// runs it as its own button would (src/client/ide/palette-run.ts). Plain CommonJS, no dependencies beyond node built-ins and vscode.
const crypto = require("node:crypto");
const { ownTasks } = require("./board-label.js");

/** The actions Friday's page knows by id: held equal to src/vscode-palette.ts PAGE_ACTIONS by test/vscode-palette.test.ts. */
const PAGE_ACTIONS = ["new-chat", "race", "self-review", "send-to-agents", "hand-to-mate", "switch-tool", "search", "settings", "open-session", "open-folder"];

// The chords the IDE already has for some of them, as [Mac, elsewhere]: said beside the action, as the page's palette says them.
const KEYS = {
  // Not one the IDE binds (Cmd/Ctrl+Shift+; is its "Focus Breadcrumbs"): checked against the bundled IDE's own list in test/vscode-palette.test.ts.
  palette: ["⌘⇧'", "Ctrl+Shift+'"],
  askAgent: ["⌘L", "Ctrl+L"],
  askCodebase: ["⌘⌥A", "Ctrl+K Ctrl+A"],
  mode: ["⌘E", "Ctrl+E"],
  agent: ["⌘⌥B", "Ctrl+Alt+B"],
};

// What each one needs to make sense: a folder open, a chat in the column, changes to look at, a file open, something to pick from.
const NEEDS = {
  folder: (s) => !!s.folder,
  noFolder: (s) => !s.folder,
  chat: (s) => !!s.chat,
  changes: (s) => s.changes !== false,
  editor: (s) => !!s.editor,
  codeChats: (s) => (s.codeChats || []).length > 0,
  agents: (s) => (s.agents || []).length > 0,
};

// In the order they are listed. `command` runs in the IDE; `page` is sent to Friday; `pick` opens a second list.
const DEFS = [
  { id: "new-chat", label: "New chat", icon: "add", detail: "A fresh chat in the column", need: ["folder"], page: "new-chat" },
  { id: "ask-codebase", label: "Ask the codebase", icon: "search", key: "askCodebase", need: ["folder"], command: "friday.askCodebase" },
  { id: "ask-agent", label: "Ask an agent about this code", icon: "comment", key: "askAgent", need: ["folder", "editor"], command: "friday.askAgent" },
  { id: "race", label: "Race this ask", icon: "run-all", detail: "The same ask to two or three coding tools", need: ["folder"], page: "race" },
  { id: "review", label: "Review changes", icon: "diff", detail: "This branch, in the IDE's own diff", need: ["folder", "changes"], command: "friday.reviewChanges" },
  { id: "self-review", label: "Self-review", icon: "shield", detail: "The agent reviews its own diff", need: ["folder", "chat", "changes"], page: "self-review" },
  { id: "send-to-agents", label: "Send this chat to Agents", icon: "export", detail: "A big job: carries on in Agents", need: ["folder", "chat"], page: "send-to-agents" },
  { id: "hand-to-mate", label: "Hand to a teammate…", icon: "organization", detail: "A Crew teammate carries it on", need: ["folder", "chat"], page: "hand-to-mate" },
  { id: "find-break", label: "Find what broke", icon: "history", detail: "The commit that broke it", need: ["folder"], command: "friday.findBreak" },
  { id: "refactor", label: "Refactor across the codebase…", icon: "symbol-structure", detail: "Plan every file first", need: ["folder"], command: "friday.refactorAcross" },
  { id: "switch-tool", label: "Switch coding tool", icon: "sync", detail: "For the new chat's box", need: ["folder"], page: "switch-tool" },
  { id: "open-chat", label: "Open a Code chat…", icon: "comment-discussion", need: ["codeChats"], pick: "chats" },
  { id: "open-session", label: "Open an Agents session…", icon: "link-external", need: ["agents"], pick: "agents" },
  { id: "open-folder", label: "Open a folder", icon: "folder-opened", need: ["noFolder"], page: "open-folder" },
  { id: "search", label: "Search chats and sessions", icon: "search-view-icon", detail: "What was said, anywhere in Friday", need: [], page: "search" },
  { id: "agents", label: "Go to Agents", icon: "home", key: "mode", need: [], command: "friday.switchMode" },
  { id: "toggle-chat", label: "Show or hide the chat column", icon: "layout-sidebar-right", key: "agent", need: [], command: "friday.toggleAgent" },
  { id: "settings", label: "Friday settings", icon: "gear", need: [], page: "settings" },
];

/**
 * The actions to list for where the window is. `state`: folder (the open folder or ""), chat (a chat is in the column), changes
 * (false only when there is surely nothing to review), editor (a file is open), codeChats and agents (what the two "Open…"
 * rows would list). Hidden, not greyed: a row that cannot do anything is only in the way.
 */
function actionList(state, mac) {
  const s = state || {};
  return DEFS.filter((d) => d.need.every((n) => NEEDS[n](s))).map((d) => {
    const chord = d.key ? KEYS[d.key][mac ? 0 : 1] : "";
    const count = d.pick === "chats" ? (s.codeChats || []).length : d.pick === "agents" ? (s.agents || []).length : 0;
    return { id: d.id, label: d.label, icon: d.icon, chord, detail: count ? `${count} to pick from` : d.detail || "", ...(d.command ? { command: d.command } : {}), ...(d.page ? { page: d.page } : {}), ...(d.pick ? { pick: d.pick } : {}) };
  });
}

/**
 * The quick pick's own row for an action: the icon in its label, and beside it the chord where there is one, else a few words on
 * what it does. One line a row, so the whole list fits without scrolling.
 */
function pickItem(a) {
  return { label: `$(${a.icon}) ${a.label}`, description: a.chord || a.detail || "", action: a };
}

/**
 * Whether there can be anything to review, from what git says: false only on main or master, clean, in step with its remote and
 * with no task changing files, where the branch has nothing over its base. Anywhere else (a feature branch that was pushed still
 * differs from its base) it is "maybe": the list keeps Review changes. Unknown (no git here, no remote to compare) is "maybe" too.
 */
function reviewable(g) {
  if (!g) return undefined;
  const base = g.branch === "main" || g.branch === "master";
  return base && !g.dirty && g.ahead === 0 && !g.taskFiles ? false : true;
}

function rootKey(root) {
  let r = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:/.test(r) || String(root).startsWith("\\\\")) r = r.toLowerCase();
  return crypto.createHash("sha1").update(r).digest("hex").slice(0, 12);
}
const sameFolder = (a, b) => !!a && !!b && rootKey(a) === rootKey(b);
const folderName = (f) => String(f || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(f || "");

/** A look at Friday's pages for this window: a short wait, so a Friday that is away never holds the palette up. */
async function fetchJson(route, token, ms) {
  const base = (process.env.FRIDAY_URL || "").replace(/\/+$/, "");
  if (!base || !token) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${base}${route}`, { headers: { "x-friday-vscode": token }, signal: ctl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What git says about the folder, only when git is already up (starting it can take seconds): branch, a dirty tree, commits ahead. */
async function gitLook(vscode, root) {
  try {
    const ext = vscode.extensions && vscode.extensions.getExtension("vscode.git");
    if (!ext || !ext.isActive || !root) return null;
    const api = ext.exports.getAPI(1);
    const repo = api.repositories.find((r) => sameFolder(r.rootUri.fsPath, root)) || api.repositories[0];
    if (!repo || !repo.state.HEAD) return null;
    return { branch: repo.state.HEAD.name, dirty: repo.state.workingTreeChanges.length + repo.state.indexChanges.length > 0, ahead: repo.state.HEAD.ahead };
  } catch {
    return null;
  }
}

/** The state `actionList` takes, read now. */
async function gather(vscode, host) {
  const root = host.roots()[0] || "";
  const token = process.env.FRIDAY_VSCODE_TOKEN || "";
  const [board, feed, git] = await Promise.all([fetchJson("/api/vscode/tasks", token, 1500), fetchJson("/api/vscode/palette", token, 1500), gitLook(vscode, root)]);
  // The board also lists Agents sessions of this folder: they are not Code chats (the palette has its own Agents list).
  const tasks = ownTasks(board && board.tasks);
  const here = tasks.filter((t) => sameFolder(t.folder, root));
  // The page says which chat the column shows; without it, any chat in this folder is the best guess.
  const chat = feed ? !!(feed.chat && sameFolder(feed.chat.folder, root)) : here.length > 0;
  const taskFiles = here.reduce((n, t) => n + (t.files || []).length, 0);
  const editor = !!(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === "file");
  return {
    folder: root,
    chat,
    changes: reviewable(git && { ...git, taskFiles }),
    editor,
    // This folder's chats first, then the others, newest first in each.
    codeChats: [...tasks].sort((a, b) => Number(sameFolder(b.folder, root)) - Number(sameFolder(a.folder, root)) || (b.at || 0) - (a.at || 0)),
    agents: feed && Array.isArray(feed.agents) ? feed.agents : [],
  };
}

function register(vscode, context, host) {
  if (!vscode.window || !vscode.window.showQuickPick || !vscode.commands) return null;
  const mac = process.platform === "darwin";
  const reach = (action, extra) => host.sendKey("action", { action, ...extra });

  async function pick(a, state) {
    if (a.command) return void (await vscode.commands.executeCommand(a.command));
    if (a.page) return reach(a.page);
    if (a.pick === "chats") {
      const rows = state.codeChats.slice(0, 40).map((t) => ({ label: `$(comment) ${t.title || "Untitled"}`, description: [t.detail, folderName(t.folder)].filter(Boolean).join(" · "), sid: t.sid }));
      const got = await vscode.window.showQuickPick(rows, { placeHolder: "Open a Code chat", matchOnDescription: true });
      if (got) host.sendKey("task", { sid: got.sid });
    } else if (a.pick === "agents") {
      const rows = state.agents.slice(0, 40).map((t) => ({ label: `$(link-external) ${t.title || "Untitled session"}`, sid: t.sid, invite: t.invite }));
      const got = await vscode.window.showQuickPick(rows, { placeHolder: "Open an Agents session" });
      if (got) reach("open-session", { sid: got.sid, invite: got.invite });
    }
  }

  const rowsFor = (state) => actionList(state, mac).map(pickItem);
  // What the last look found: the next pick shows it at once, and is corrected when its own look is back.
  let lastState = null;
  let opening = false;

  async function open() {
    // A second press while one is open does nothing: it would only queue a second pick.
    if (opening) return;
    opening = true;
    try {
      const placeHolder = "Friday: what do you want to do?";
      if (!vscode.window.createQuickPick) {
        const state = await gather(vscode, host);
        const got = await vscode.window.showQuickPick(rowsFor(state), { placeHolder, matchOnDescription: true });
        if (got) await pick(got.action, state);
        return;
      }
      // Shown at once, busy while Friday is asked what it holds (a slow or away Friday must not make the key look dead).
      const qp = vscode.window.createQuickPick();
      qp.placeholder = placeHolder;
      qp.matchOnDescription = true;
      qp.busy = true;
      qp.items = lastState ? rowsFor(lastState) : [];
      let state = lastState || {};
      let chosen = null;
      const closed = new Promise((resolve) => {
        qp.onDidAccept(() => {
          chosen = qp.selectedItems[0] || null;
          qp.hide();
        });
        qp.onDidHide(() => {
          qp.dispose();
          resolve();
        });
      });
      qp.show();
      gather(vscode, host).then(
        (fresh) => {
          state = lastState = fresh;
          qp.items = rowsFor(fresh);
          qp.busy = false;
        },
        () => void (qp.busy = false),
      );
      await closed;
      if (chosen) await pick(chosen.action, state);
    } finally {
      opening = false;
    }
  }
  context.subscriptions.push(vscode.commands.registerCommand("friday.palette", () => void open()));

  // The ✳ in the status bar, beside the key.
  if (vscode.window.createStatusBarItem) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment ? vscode.StatusBarAlignment.Left : 1, 1000);
    item.name = "Friday: everything Friday can do here";
    item.text = "$(sparkle)";
    item.tooltip = `Everything Friday can do here (${KEYS.palette[mac ? 0 : 1]})`;
    item.command = "friday.palette";
    item.show();
    context.subscriptions.push(item);
  }
  return { open };
}

module.exports = { register, actionList, reviewable, gather, PAGE_ACTIONS, DEFS, KEYS };
