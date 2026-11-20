"use strict";
// CI in the IDE (Arun, 2026-11-19, wave 3: "CI in the IDE: the PR's checks in the status bar; a failure opens at the failing line with the
// log, and Fix with Friday."): the folder's pull request, its checks counted in the status bar ("✓ 12 checks", "✗ 2 failing",
// "◌ 3 running"), a pick of the checks on a click, a failed check's log in an Output channel with the places it names as Problems (a
// "CI" collection, each with the Fix with Friday action every Problem has), and Fix with Friday on the failed ones as a whole.
// Read from Friday (/api/vscode/ci, which asks this computer's own gh): every 15 s while any check runs (ci-parse nextDelay), every minute otherwise, and
// nothing at all while there is no open pull request. The pure parts are ci-parse.js, tested on their own.
const { parseLog, resolveFile, statusWords, signature, cleanText, nextDelay, notice, droppedIds, channelLabel } = require("./ci-parse.js");

function register(vscode, context, { postAsk, roots }) {
  if (!vscode.window || !vscode.window.createStatusBarItem || !vscode.languages || !vscode.languages.createDiagnosticCollection) return null;
  const base = () => (process.env.FRIDAY_URL || "").replace(/\/+$/, "");
  const token = () => process.env.FRIDAY_VSCODE_TOKEN || "";
  const root = () => roots()[0] || "";
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
  item.name = "Friday: pull request checks";
  item.command = "friday.ciChecks";
  const problems = vscode.languages.createDiagnosticCollection("CI");
  const channels = new Map();
  // Each failed check's places, by check, so the Problems list holds those the person opened and drops those that pass now.
  const placed = new Map();
  let overview = null;
  let sig = "";
  let seenFailing = "";
  // Said only after a real answer has been seen, so a window that opens onto a red pull request stays quiet.
  let armed = false;
  // The look in progress that counts: an answer from an older one is ignored (the newest says how things stand now).
  let seq = 0;
  let timer;
  let later;
  let disposed = false;
  // A slow read (the log of a check, the logs of the failed ones) shows in the status bar, so a click doesn't look dead.
  const busy = (title, fn) => (vscode.window.withProgress && vscode.ProgressLocation ? vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn) : fn());

  async function ask(query) {
    if (!base() || !token() || !root()) return null;
    try {
      const res = await fetch(`${base()}/api/vscode/ci?folder=${encodeURIComponent(root())}${query || ""}`, { headers: { "x-friday-vscode": token() } });
      return res.ok ? await res.json() : null;
    } catch {
      // Friday is away a moment: the item keeps what it had.
      return null;
    }
  }

  function repaintProblems() {
    problems.clear();
    const byFile = new Map();
    for (const list of placed.values()) for (const [file, ds] of list) byFile.set(file, [...(byFile.get(file) || []), ...ds]);
    for (const [file, ds] of byFile) problems.set(vscode.Uri.file(file), ds);
  }

  function paint() {
    const w = statusWords(overview);
    if (!w) {
      item.hide();
      return;
    }
    item.text = `$(${w.icon}) ${w.text}`;
    // Failing is told by the colour of the words, not a block of red in the bar (Arun, 2026-11-19: "quiet").
    item.color = w.state === "failing" ? new vscode.ThemeColor("errorForeground") : undefined;
    const c = overview.counts;
    const md = new vscode.MarkdownString();
    md.appendText(`#${overview.pr.number} ${overview.pr.title}\n${[c.fail ? `${c.fail} failing` : "", c.pending ? `${c.pending} running` : "", c.pass ? `${c.pass} passed` : ""].filter(Boolean).join(" · ")}\nClick for the checks`);
    item.tooltip = md;
    item.show();
  }

  async function look(fresh) {
    clearTimeout(timer);
    const mine = ++seq;
    const o = await ask(fresh ? "&fresh=1" : "");
    if (disposed || mine !== seq) return;
    // gh trouble (offline, rate limit, a slow token refresh) says `error`: that is not "the pull request is gone", so what was shown stays.
    if (o && typeof o === "object" && "checks" in o && !o.error) {
      const was = overview;
      overview = o;
      // A different branch or pull request: what was opened for the last is no longer this one's.
      if (was && was.pr && (!o.pr || was.pr.url !== o.pr.url)) {
        placed.clear();
        repaintProblems();
      }
      const gone = droppedIds(placed.keys(), o);
      for (const id of gone) placed.delete(id);
      if (gone.length) repaintProblems();
      const next = signature(o);
      if (next !== sig) {
        sig = next;
        paint();
      }
      // Said once when checks turn red while the window is open, not on every window that opens onto a red pull request.
      const say = notice(o, seenFailing, armed);
      seenFailing = say.seen;
      armed = true;
      if (say.say) {
        const n = say.say;
        void vscode.window.showWarningMessage(`${n} check${n === 1 ? "" : "s"} failing on #${o.pr.number}`, "Show the checks", "Fix with Friday").then((pick) => {
          if (pick === "Show the checks") void vscode.commands.executeCommand("friday.ciChecks");
          else if (pick === "Fix with Friday") void vscode.commands.executeCommand("friday.ciFix");
        });
      }
    }
    clearTimeout(timer);
    timer = setTimeout(() => void look(false), nextDelay(overview));
  }

  function channelFor(label, id) {
    const key = `CI: ${label}`;
    let ch = channels.get(id);
    if (!ch) {
      ch = vscode.window.createOutputChannel(key);
      channels.set(id, ch);
      context.subscriptions.push(ch);
    }
    return ch;
  }

  /** A check picked (by id; a name works while no other check has it): a failed one opens its log and where it points; any other opens on GitHub. */
  async function openCheck(which) {
    const checks = (overview && overview.checks) || [];
    const check = checks.find((c) => (c.id || c.name) === which) || checks.find((c) => c.name === which);
    if (!check) return;
    const id = check.id || check.name;
    const label = channelLabel(checks, check);
    const failed = check.bucket === "fail" || check.bucket === "cancel";
    const open = () => check.link && vscode.env && vscode.env.openExternal && vscode.env.openExternal(vscode.Uri.parse(check.link));
    if (!failed) return void open();
    const got = await busy(`Reading the log of ${check.name}…`, () => ask(`&log=${encodeURIComponent(id)}`));
    if (!got || !got.log) {
      const pick = await vscode.window.showInformationMessage(
        !got ? `Couldn't reach Friday to read the log of “${check.name}”.` : check.bucket === "cancel" ? `“${check.name}” was cancelled: it has no log.` : `No log to read for “${check.name}” here.`,
        ...(check.link ? ["Open on GitHub"] : []),
      );
      if (pick) open();
      return;
    }
    const ch = channelFor(label, id);
    ch.clear();
    ch.appendLine(`${label}${check.workflow && !label.includes(check.workflow) ? ` (${check.workflow})` : ""}${overview.pr ? ` · pull request #${overview.pr.number}` : ""}`);
    ch.appendLine("");
    ch.append(cleanText(got.log));
    // The places the log names, those that are in this folder, as Problems.
    const here = root();
    const byFile = new Map();
    let firstAt = null;
    for (const d of parseLog(got.log)) {
      const file = resolveFile(here, d.file);
      if (!file) continue;
      const range = new vscode.Range(d.line - 1, d.col - 1, d.line - 1, Number.MAX_SAFE_INTEGER);
      const diag = new vscode.Diagnostic(range, d.message, d.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      diag.source = "CI";
      diag.code = check.name;
      byFile.set(file, [...(byFile.get(file) || []), diag]);
      if (!firstAt) firstAt = { file, line: d.line - 1, col: d.col - 1 };
    }
    placed.set(id, byFile);
    repaintProblems();
    // The log, without taking focus from the editor that opens next on the failing line.
    ch.show(true);
    if (!firstAt) {
      void vscode.window.showInformationMessage(`“${check.name}” failed, but its log names no file and line here. It is in the Output panel.`);
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(firstAt.file));
      const pos = new vscode.Position(firstAt.line, Math.max(0, firstAt.col));
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
    } catch {
      // A file that is gone or unreadable is simply not opened: the Problems row is still there.
    }
  }

  async function pickCheck() {
    if (!overview || !overview.pr) return;
    const sep = (label) => ({ label, kind: vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : undefined });
    const rows = [];
    const failing = (overview.checks || []).filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    const running = (overview.checks || []).filter((c) => c.bucket === "pending");
    const passed = (overview.checks || []).filter((c) => c.bucket === "pass" || c.bucket === "skipping");
    if (failing.length) rows.push({ label: "$(sparkle) Fix with Friday", description: `hand ${failing.length === 1 ? "this check" : `these ${failing.length} checks`} to a chat`, act: "fix" });
    const group = (title, list, icon) => {
      if (!list.length) return;
      if (vscode.QuickPickItemKind) rows.push(sep(title));
      for (const c of list) rows.push({ label: `$(${icon(c)}) ${c.name}`, description: [c.workflow, c.bucket === "cancel" ? "cancelled" : c.bucket === "skipping" ? "skipped" : ""].filter(Boolean).join(" · "), check: c.id || c.name });
    };
    group("Failing", failing, () => "error");
    group("Running", running, () => "sync~spin");
    group("Passed", passed, (c) => (c.bucket === "skipping" ? "circle-slash" : "pass"));
    if (vscode.QuickPickItemKind) rows.push(sep(""));
    rows.push({ label: "$(link-external) Open the pull request", description: `#${overview.pr.number}`, act: "pr" });
    const pick = await vscode.window.showQuickPick(rows, { title: `Checks on #${overview.pr.number} ${overview.pr.title}`.slice(0, 90), placeHolder: failing.length ? "Pick a failed check to read its log at the line it names" : "Pick a check to open it" });
    if (!pick) return;
    if (pick.act === "fix") return void vscode.commands.executeCommand("friday.ciFix");
    if (pick.act === "pr") return void (vscode.env && vscode.env.openExternal && vscode.env.openExternal(vscode.Uri.parse(overview.pr.url)));
    if (pick.check) await openCheck(pick.check);
  }

  async function fixAll() {
    const got = await (vscode.window.withProgress && vscode.ProgressLocation ? vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Reading the logs of the failed checks…" }, () => ask("&fix=1")) : ask("&fix=1"));
    if (!got) {
      void vscode.window.showInformationMessage("Couldn't reach Friday to read the failed checks. Try again in a moment.");
      return;
    }
    if (!got.text) {
      void vscode.window.showInformationMessage("No check is failing on this branch's pull request.");
      return;
    }
    if (await postAsk({ kind: "ci", path: "", from: 1, to: 1, text: "", root: root(), problem: got.text, source: "CI" })) vscode.window.setStatusBarMessage("Sent the failed checks to Friday's agent panel", 2500);
  }

  context.subscriptions.push(
    item,
    problems,
    { dispose: () => ((disposed = true), clearTimeout(timer), clearTimeout(later)) },
    vscode.commands.registerCommand("friday.ciChecks", () => void pickCheck()),
    vscode.commands.registerCommand("friday.ciFix", () => void fixAll()),
    vscode.commands.registerCommand("friday.ciOpenCheck", (name) => typeof name === "string" && void openCheck(name)),
    vscode.commands.registerCommand("friday.ciRefresh", () => void look(true)),
  );
  // A window brought back to the front looks again at once: checks moved on while it was away.
  if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && void look(false)));
  // A branch switched or a commit made: the git extension says so, and the checks of the new head are looked at now.
  try {
    const git = vscode.extensions && vscode.extensions.getExtension("vscode.git");
    if (git) {
      void Promise.resolve(git.isActive ? git.exports : git.activate()).then((ex) => {
        const api = ex && ex.getAPI && ex.getAPI(1);
        if (!api) return;
        const watch = (repo) => {
          // The branch and commit, and what a push changes: the commit the remote has (a push leaves HEAD alone).
          const keyOf = () => {
            const h = repo.state.HEAD;
            return h ? { head: `${h.name}@${h.commit}`, remote: `${h.upstream && h.upstream.commit}|${h.ahead}` } : { head: "", remote: "" };
          };
          let was = keyOf();
          context.subscriptions.push(
            repo.state.onDidChange(() => {
              const now = keyOf();
              if (now.head === was.head && now.remote === was.remote) return;
              const pushed = now.head === was.head && now.remote !== was.remote;
              was = now;
              void look(true);
              // GitHub needs a moment to register a pushed head's checks: looked at again.
              if (pushed) {
                clearTimeout(later);
                later = setTimeout(() => void look(true), 6000);
              }
            }),
          );
        };
        api.repositories.forEach(watch);
        if (api.onDidOpenRepository) context.subscriptions.push(api.onDidOpenRepository(watch));
      });
    }
  } catch {
    // The minute's look covers it.
  }
  void look(false);
  return { look, openCheck, state: () => overview };
}

module.exports = { register };
