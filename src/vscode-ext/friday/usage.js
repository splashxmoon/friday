"use strict";
// The coding tool's remaining window in the status bar, only when it is low (Arun, 2026-11-20, wave 5: "Claude Code 12% left"). Read
// from Friday's task list (/api/vscode/tasks: each task's `plan`, from its tool's runner), once a minute (a faster look hid it between readings: 2026-11-20) and when the window comes
// forward; the item is not there at all while the tool has 20% or more left. A click opens Friday's task board.
const { currentTask, usageItem } = require("./usage-parse.js");

function register(vscode, context, { roots }) {
  if (!vscode.window || !vscode.window.createStatusBarItem) return null;
  const base = () => (process.env.FRIDAY_URL || "").replace(/\/+$/, "");
  const token = () => process.env.FRIDAY_VSCODE_TOKEN || "";
  // Left, after the pull request's checks: the right is under the chat, which covers the IDE's bottom right.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment ? vscode.StatusBarAlignment.Left : 1, 6);
  item.name = "Friday: coding tool usage";
  item.command = "friday.showTasks";
  let disposed = false;
  let timer;

  async function look() {
    if (disposed || !base() || !token()) return;
    try {
      const res = await fetch(`${base()}/api/vscode/tasks`, { headers: { "x-friday-vscode": token() } });
      if (!res.ok) return;
      const body = await res.json();
      const say = usageItem(currentTask(body.tasks, roots()));
      if (!say) return void item.hide();
      item.text = say.text;
      item.tooltip = say.tooltip;
      if (vscode.ThemeColor) item.backgroundColor = say.error ? new vscode.ThemeColor("statusBarItem.errorBackground") : new vscode.ThemeColor("statusBarItem.warningBackground");
      item.show();
    } catch {
      // Friday is away a moment: what is shown stands.
    }
  }
  const again = () => {
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(() => void look().finally(again), 60_000);
  };
  context.subscriptions.push(item, { dispose: () => ((disposed = true), clearTimeout(timer)) });
  if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && void look()));
  void look();
  again();
  return { look };
}

module.exports = { register };
