"use strict";
// Dev servers managed (Arun, 2026-11-19, wave 4: "Dev servers managed: Friday starts your app's server, keeps it running across agent
// runs, shows its port and logs, and restarts it when it crashes."): a "Servers" status item ("● :3000 web" / "○ no server") and a list
// in the Friday container of the folder's servers, each with Start, Stop, Restart, Open in the browser and Show logs (an Output channel
// per server, fed from Friday). Friday's runner owns the processes (runner/dev-servers.ts), so reloading the IDE or an agent's run
// leaves them going; this file only asks, and shows. The pure parts are servers-parse.js.
const { describe, iconFor, statusWords, signature, notices, nextDelay, logText, isUp } = require("./servers-parse.js");

function register(vscode, context, { roots }) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const ids = ["friday.servers.start", "friday.servers.stop", "friday.servers.restart", "friday.servers.open", "friday.servers.openInIde", "friday.servers.logs", "friday.servers.refresh", "friday.servers.menu", "friday.showServers"];
  if (!vscode.window || !vscode.window.createStatusBarItem || !vscode.window.createTreeView || !vscode.EventEmitter) {
    for (const id of ids) reg(id, () => vscode.window && vscode.window.showInformationMessage("The Servers view isn't available in this window."));
    return null;
  }
  const base = () => (process.env.FRIDAY_URL || "").replace(/\/+$/, "");
  const token = () => process.env.FRIDAY_VSCODE_TOKEN || "";
  // Every folder of the window, not only the first: a server is listed under its own folder.
  const folders = () => [...new Set(roots())].slice(0, 6);
  const base0 = (r) => String(r).split(/[\\/]/).filter(Boolean).pop() || r;
  const label = (s) => (multi() ? `${s.name} (${base0(s.root)})` : s.name);
  const multi = () => folders().length > 1;
  const changed = new vscode.EventEmitter();
  let servers = [];
  let external = [];
  let hasShown = null;
  let sig = "";
  let armed = false;
  let seq = 0;
  let timer;
  let disposed = false;
  let view;
  let lastError = "";
  // Rows with a start, stop or restart in flight: their buttons are gone until it is done, so a second click can't start a second one.
  const busy = new Set();
  const bkey = (s) => `${s.root}\0${s.id}`;
  // The external scan (lsof, ps) is only asked for while the list can be seen; the last answer is kept in between.
  let menuAt = 0;
  const watching = () => (view && view.visible) || Date.now() - menuAt < 5000;

  async function call(method, path, body) {
    if (!base() || !token() || !folders().length) return null;
    try {
      const res = await fetch(`${base()}/api/vscode/servers${path}`, { method, headers: { "x-friday-vscode": token(), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return res.ok ? await res.json() : null;
    } catch {
      // Friday is away a moment: the list keeps what it had.
      return null;
    }
  }

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 7);
  item.name = "Friday: servers";
  item.command = "friday.servers.menu";
  context.subscriptions.push(item, changed);

  function paint() {
    const w = statusWords(servers, external);
    item.text = `$(${w.icon}) ${w.text}`;
    item.color = w.state === "crashed" ? new vscode.ThemeColor("errorForeground") : undefined;
    const md = new vscode.MarkdownString();
    const rows = servers.filter((s) => s.phase !== "stopped").map((s) => `${label(s)}: ${describe(s)}`);
    for (const x of external) rows.push(`:${x.port} (started elsewhere)`);
    md.appendText(`${rows.length ? rows.join("\n") : "No server is running for this folder."}\nClick for the servers`);
    item.tooltip = md;
    // Only while one runs (or crashed): "○ no server" in the status bar is clutter (Arun, 2026-11-20, of a count like it: "get rid of
    // this"). The Servers view, shown when the folder has one, is the way to Start.
    if (rows.length || w.state === "crashed") item.show();
    else item.hide();
  }

  async function look() {
    clearTimeout(timer);
    const mine = ++seq;
    const withExternal = watching();
    const got = await Promise.all(folders().map(async (root) => ({ root, r: await call("GET", `?root=${encodeURIComponent(root)}&external=${withExternal ? 1 : 0}`) })));
    if (disposed || mine !== seq) return;
    const ok = got.filter((g) => g.r && Array.isArray(g.r.servers));
    if (ok.length) {
      lastError = ok.map((g) => g.r.error || "").find(Boolean) || "";
      const was = servers;
      servers = ok.flatMap((g) => g.r.servers.map((x) => ({ ...x, root: g.root })));
      if (withExternal) external = ok.flatMap((g) => (Array.isArray(g.r.external) ? g.r.external.map((x) => ({ ...x, root: g.root })) : []));
      for (const n of notices(was, servers, armed)) {
        const pick = n.kind === "crashed" ? ["Show logs", "Start again"] : ["Show logs"];
        void vscode.window[n.kind === "crashed" ? "showWarningMessage" : "showInformationMessage"](n.text, ...pick).then((p) => {
          const s = servers.find((x) => x.id === n.id && (!n.root || x.root === n.root));
          if (p === "Show logs") void showLogs(s);
          else if (p === "Start again" && s) void act("start", s);
        });
      }
      armed = true;
      const next = signature(servers, external);
      if (next !== sig) {
        sig = next;
        paint();
      }
      // The list is redrawn on every look: notes and counts change without the status bar's words doing so.
      changed.fire();
      // Shown in Friday's side bar only when the folder has a server to show (Arun, 2026-11-20: a side bar of empty views is clutter).
      // Said only when it changes: the IDE redraws the side bar's views on each, and a redraw mid-fold of another view trips it.
      const has = servers.length + external.length > 0;
      if (has !== hasShown) {
        hasShown = has;
        void Promise.resolve(vscode.commands.executeCommand("setContext", "friday.hasServers", has)).catch(() => {});
      }
      if (view) view.message = lastError || (!servers.length && !external.length ? "No server found. A dev, start or serve script in package.json, a Procfile or a compose file shows up here." : undefined);
    }
    clearTimeout(timer);
    // A window nobody is looking at asks a third as often.
    const focused = !vscode.window.state || vscode.window.state.focused !== false;
    timer = setTimeout(() => void look(), nextDelay(servers) * (focused ? 1 : 3));
  }

  // Output channels, one per server, fed by a cursor into the log Friday keeps.
  const channels = new Map();
  let feed;
  let pumping = null;
  // One pass at a time: the timer and a Show logs click would both read from the same cursor and write the same lines twice.
  function pump() {
    if (!pumping) pumping = pumpOnce().finally(() => (pumping = null));
    return pumping;
  }
  async function pumpOnce() {
    for (const c of [...channels.values()]) {
      const r = await call("GET", `?root=${encodeURIComponent(c.root)}&log=${encodeURIComponent(c.id)}&since=${c.cursor}`);
      if (!r || !Array.isArray(r.lines)) continue;
      // A log that began again (the server was started afresh) starts the channel over.
      if (r.last < c.cursor) {
        c.channel.clear();
        c.cursor = 0;
        continue;
      }
      if (r.lines.length) c.channel.appendLine(logText(r.lines));
      c.cursor = r.last;
    }
  }
  function ensureFeed() {
    if (!feed) feed = setInterval(() => void pump(), 1500);
  }
  context.subscriptions.push({ dispose: () => (clearInterval(feed), clearTimeout(timer), (disposed = true)) });

  async function showLogs(s) {
    if (!s) return;
    let c = channels.get(bkey(s));
    if (!c) {
      const channel = vscode.window.createOutputChannel(`Friday: ${label(s)}`);
      context.subscriptions.push(channel);
      c = { channel, cursor: 0, root: s.root, id: s.id };
      channels.set(bkey(s), c);
      ensureFeed();
    }
    await pump();
    c.channel.show(true);
    if (!s.lines && !s.managed) void vscode.window.showInformationMessage(`${s.name} hasn't been started from here yet, so there is no log. Start it and its output appears.`);
  }

  async function act(op, s) {
    if (!s || busy.has(bkey(s))) return;
    busy.add(bkey(s));
    changed.fire();
    const word = { start: "Starting", stop: "Stopping", restart: "Restarting" }[op];
    const run = () => call("POST", "", { op, root: s.root, id: s.id });
    try {
      const r = vscode.window.withProgress && vscode.ProgressLocation ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${word} ${s.name}…` }, run) : await run();
      if (!r) void vscode.window.showErrorMessage("Couldn't reach Friday to do that.");
      else if (r.error) void vscode.window.showErrorMessage(r.error);
      // A server just started gets its log open, the way a terminal would show what it prints.
      else if (op !== "stop") void showLogs({ ...s, managed: true, lines: 1 });
    } finally {
      busy.delete(bkey(s));
    }
    await look();
  }

  const urlOf = (s) => (s && s.port && (s.phase === "running" || s.external) ? `http://localhost:${s.port}` : "");
  function openOutside(s) {
    const url = urlOf(s);
    if (!url) return void vscode.window.showInformationMessage(`${s ? s.name : "That server"} isn't up yet.`);
    if (vscode.env && vscode.env.openExternal && vscode.Uri) void vscode.env.openExternal(vscode.Uri.parse(url));
  }
  async function openInside(s) {
    const url = urlOf(s);
    if (!url) return void vscode.window.showInformationMessage(`${s ? s.name : "That server"} isn't up yet.`);
    try {
      await vscode.commands.executeCommand("simpleBrowser.show", url);
    } catch {
      openOutside(s);
    }
  }

  const rows = () => [...servers.map((s) => ({ kind: "server", s })), ...external.map((x) => ({ kind: "server", s: { id: `ext:${x.port}`, root: x.root, name: `:${x.port}`, phase: "running", port: x.port, command: x.command, external: true, managed: false, tries: 0, lines: 0 } }))];
  // More than one folder in the window: the servers sit under their folder.
  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren: (el) => {
      if (!el) return multi() ? folders().map((root) => ({ kind: "root", root })) : rows();
      return el.kind === "root" ? rows().filter((r) => r.s.root === el.root) : [];
    },
    getTreeItem(el) {
      if (el.kind === "root") {
        const g = new vscode.TreeItem(base0(el.root), vscode.TreeItemCollapsibleState.Expanded);
        g.id = `root-${el.root}`;
        g.iconPath = vscode.ThemeIcon ? new vscode.ThemeIcon("folder") : undefined;
        g.tooltip = el.root;
        return g;
      }
      const s = el.s;
      const t = new vscode.TreeItem(s.external ? `localhost:${s.port}` : s.name, vscode.TreeItemCollapsibleState.None);
      t.id = `server-${s.root}-${s.id}`;
      const working = busy.has(bkey(s));
      t.description = working ? "working…" : s.external ? `${s.command || "started elsewhere"}` : describe(s);
      // While something is in flight no row action matches, so none is offered twice.
      t.contextValue = working ? "friday.server.busy" : s.external ? "friday.server.external" : isUp(s) ? "friday.server.up" : "friday.server.down";
      const icon = iconFor(s);
      if (vscode.ThemeIcon) t.iconPath = icon.color && vscode.ThemeColor ? new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(icon.color)) : new vscode.ThemeIcon(icon.id);
      const lines = [s.external ? `Started outside Friday: ${s.command}` : s.command, s.port && isUp(s) ? `http://localhost:${s.port}` : "", s.note].filter(Boolean);
      t.tooltip = lines.join("\n");
      if (!s.external) t.command = { command: "friday.servers.logs", title: "Show logs", arguments: [el] };
      return t;
    },
  };
  view = vscode.window.createTreeView("friday.servers", { treeDataProvider: provider, showCollapseAll: false });
  view.title = "Servers";
  context.subscriptions.push(view);

  const pick = (arg) => (arg && arg.s ? arg.s : arg && arg.id ? arg : null);
  reg("friday.servers.start", (el) => act("start", pick(el)));
  reg("friday.servers.stop", async (el) => {
    const s = pick(el);
    if (s && s.external) {
      const r = await call("POST", "", { op: "stop-port", root: s.root, port: s.port });
      if (r && r.error) void vscode.window.showErrorMessage(r.error);
      return void look();
    }
    return act("stop", s);
  });
  reg("friday.servers.restart", (el) => act("restart", pick(el)));
  reg("friday.servers.open", (el) => openOutside(pick(el)));
  reg("friday.servers.openInIde", (el) => openInside(pick(el)));
  reg("friday.servers.logs", (el) => showLogs(pick(el)));
  reg("friday.servers.refresh", () => void look());
  reg("friday.showServers", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.friday");
    await vscode.commands.executeCommand("friday.servers.focus");
    void look();
  });
  // The status item's click: one list of every server with what each can do next.
  reg("friday.servers.menu", async () => {
    menuAt = Date.now();
    void look();
    const all = rows().map((r) => r.s);
    if (!all.length) return void vscode.commands.executeCommand("friday.showServers");
    const sep = vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : undefined;
    const items = [];
    for (const s of all) {
      if (items.length && sep !== undefined) items.push({ label: "", kind: sep });
      const up = s.external || isUp(s);
      const where = multi() && s.root ? ` · ${base0(s.root)}` : "";
      // A stopped server's own row starts it, and says so; the rows under it say the same in a line of their own.
      items.push({ label: `$(${iconFor(s).id.replace("~spin", "")}) ${s.external ? `localhost:${s.port}` : s.name}`, description: (s.external ? s.command : describe(s)) + where, detail: up ? undefined : "Enter starts it", s, act: s.external ? "open" : up ? "open" : "start" });
      if (!up) items.push({ label: "      $(play) Start", s, act: "start" });
      if (up && !s.external) items.push({ label: "      $(debug-restart) Restart", s, act: "restart" }, { label: "      $(debug-stop) Stop", s, act: "stop" });
      if (s.external) items.push({ label: "      $(debug-stop) Stop", s, act: "stop" });
      if (!s.external) items.push({ label: "      $(output) Show logs", s, act: "logs" });
    }
    const p = await vscode.window.showQuickPick(items, { title: "Servers", placeHolder: "Pick a server" });
    if (!p || !p.s) return;
    const cmd = { open: "friday.servers.open", start: "friday.servers.start", restart: "friday.servers.restart", stop: "friday.servers.stop", logs: "friday.servers.logs" }[p.act];
    if (cmd) await vscode.commands.executeCommand(cmd, p.s);
  });

  context.subscriptions.push(view.onDidChangeVisibility((e) => e.visible && void look()));
  if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState((e) => e.focused && void look()));
  void look();
  return { look, rows: () => servers };
}

module.exports = { register };
