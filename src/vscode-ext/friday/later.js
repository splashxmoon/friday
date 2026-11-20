/**
 * Run later in the IDE's task board (Arun, 2026-11-20: "Tonight from the IDE: queue a task from Code to run overnight (or at a time),
 * with the results waiting in the morning"): a "Later" group above the rest, one line per queued task with when it starts, read from
 * Friday (/api/vscode/tasks `later`). Tasks are queued and cancelled from Run later in Friday's chat box; the board only shows them.
 * Plain CommonJS with no vscode import: the extension hands its `vscode` in, as every file here does.
 */
function clock(at) {
  const d = new Date(at);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return same ? `today ${time}` : tomorrow ? `tomorrow ${time}` : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** The group row, when anything waits. */
function laterRoot(list) {
  return list.length ? [{ later: true, items: list }] : [];
}

function laterGroupItem(vscode, el) {
  const item = new vscode.TreeItem("Later", vscode.TreeItemCollapsibleState.Expanded);
  item.description = String(el.items.length);
  item.iconPath = new vscode.ThemeIcon("history", new vscode.ThemeColor("descriptionForeground"));
  item.tooltip = "Tasks set to start at a time. Friday starts them only if it is open and this computer is awake then.";
  item.id = "group:later";
  return item;
}

/** The time alone, to lead a row: a side bar cuts the end of a row off, so what must be seen comes first ("1:00 AM", or "Sat 1:00 AM" past today). */
function lead(at) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** What marks a chat Run later started, on its row's icon (a description is cut off first, so it can't carry the mark): a moon-like history icon for the night, a clock for the day. */
function ranIcon(vscode, x) {
  return x.overnight ? new vscode.ThemeIcon(x.ran === "Ran later" ? "clock" : "history") : undefined;
}

function laterTaskItem(vscode, x) {
  const item = new vscode.TreeItem(`${lead(x.at)} · ${x.title || "Task for later"}`, vscode.TreeItemCollapsibleState.None);
  const folder = String(x.folder || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  item.description = folder || "";
  item.iconPath = new vscode.ThemeIcon("clock");
  item.tooltip = `${x.title || "Task for later"}\nStarts ${clock(x.at)} only if Friday is open and this computer is awake then (a closed lid still sleeps it). Cancel it from Run later in the chat box.`;
  item.id = `later:${x.id}`;
  return item;
}

module.exports = { clock, lead, ranIcon, laterRoot, laterGroupItem, laterTaskItem };
