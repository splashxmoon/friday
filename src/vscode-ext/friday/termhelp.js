"use strict";
// The terminal helper (Arun, 2026-11-20, wave 4: "Terminal helper: type what you want in plain words in the terminal and get the
// command; a command that fails gets explained and fixed."). Two things, both answered by the person's own coding tool through
// Friday (POST /api/vscode/terminal-help, src/term-ask.ts), read-only, as a quick one-shot:
//
//   Friday: Write a command (Cmd/Ctrl+I in the terminal)  a quick input for what you want; the command lands in the terminal's
//        input WITHOUT being run (sendText with no newline), the explanation in the status bar, a warning when it is risky
//   Explain  on a failed command (the notification watchTerminals in extension.js shows)  a quick pick: why it failed, and, when a
//        different command fixes it, "Put it in the terminal" (again not run)
//
// Nothing here presses Enter for the person.
const os = require("node:os");
const path = require("node:path");

const KEEP = 8;

/** The shell's name as the person says it: zsh, bash, fish, pwsh, cmd. */
function shellName(vscode, terminal) {
  const opts = (terminal && terminal.creationOptions) || {};
  const full = String(opts.shellPath || (vscode.env && vscode.env.shell) || "");
  return path.basename(full.replace(/\\/g, "/")).replace(/\.exe$/i, "") || "";
}

function osName() {
  return process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : `${os.type()}`;
}

/** The folder a terminal is in: its shell's own idea when shell integration says, else where it was opened, else the open folder. */
function cwdOf(terminal, roots) {
  const si = terminal && terminal.shellIntegration;
  if (si && si.cwd && si.cwd.fsPath) return si.cwd.fsPath;
  const c = terminal && terminal.creationOptions && terminal.creationOptions.cwd;
  if (typeof c === "string" && c) return c;
  if (c && c.fsPath) return c.fsPath;
  return roots()[0] || "";
}

/** A command as it goes into the terminal's input: one line, no control characters, so it can never run by itself. Spaces inside
 *  it stay as the tool wrote them (they can sit inside quotes). */
function oneLine(cmd) {
  return String(cmd).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** A sentence cut into lines of about `n` characters, at spaces (a quick pick row doesn't wrap). */
function wrap(text, n) {
  const out = [];
  let line = "";
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > n) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/** A quick input that resolves with the trimmed text, or undefined when it is dismissed. */
function askInput(vscode, title, placeholder) {
  return new Promise((resolve) => {
    if (!vscode.window.createInputBox) return resolve(vscode.window.showInputBox ? vscode.window.showInputBox({ title, placeHolder: placeholder }) : undefined);
    const box = vscode.window.createInputBox();
    box.title = title;
    box.placeholder = placeholder;
    box.prompt = "Say it in plain words. The command is typed in, not run.";
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

async function askFriday(body) {
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (!base || !token) throw new Error("Friday is not connected to this editor. Reopen Code in Friday.");
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/terminal-help`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-friday-vscode": token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Friday answered ${res.status}`);
  return json;
}

/**
 * `roots()` the folders open; `postAsk` sends an ask to Friday's column (the longer way: "Fix it", "More in Friday").
 * Returns { failed(f), explain(), write() }: `failed` is told of every failed command (the terminal watcher), `explain` shows the
 * last one's quick answer.
 */
function register(vscode, context, roots, postAsk) {
  const recent = [];
  let last = null;
  let busy = false;

  const remember = (cmd, exit) => {
    if (!cmd) return;
    recent.push({ cmd: String(cmd).slice(0, 300), exit: typeof exit === "number" ? exit : undefined });
    if (recent.length > KEEP) recent.shift();
  };
  if (vscode.window.onDidEndTerminalShellExecution) {
    context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution((e) => remember(e.execution && e.execution.commandLine && e.execution.commandLine.value, e.exitCode)));
  }

  // A program in the foreground of a terminal (vim, less, a REPL, a dev server) would take typed text as its own keystrokes.
  const running = new Map();
  const track = (t, d) => t && running.set(t, Math.max(0, (running.get(t) || 0) + d));
  if (vscode.window.onDidStartTerminalShellExecution) context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution((e) => track(e.terminal, 1)));
  if (vscode.window.onDidEndTerminalShellExecution) context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution((e) => track(e.terminal, -1)));

  const terminalFor = (preferred) => {
    const live = vscode.window.terminals || [];
    if (preferred && live.includes(preferred)) return preferred;
    return vscode.window.activeTerminal || vscode.window.createTerminal({ cwd: roots()[0] || undefined });
  };

  /** Puts a command in a terminal's input and leaves it there: the person reads it and presses Enter. False when a program is
   *  running there: the command is offered to copy or to put in a new terminal instead. */
  const putIn = (terminal, command) => {
    const t = terminalFor(terminal);
    const text = oneLine(command);
    if (running.get(t) > 0) {
      const shown = text.length > 80 ? `${text.slice(0, 79)}…` : text;
      const choice = vscode.window.showInformationMessage(`A program is running in that terminal, so the command was not typed in: ${shown}`, "Copy", "Put it in a new terminal");
      Promise.resolve(choice).then((c) => {
        if (c === "Copy" && vscode.env.clipboard) void vscode.env.clipboard.writeText(text);
        if (c === "Put it in a new terminal") {
          const n = vscode.window.createTerminal({ cwd: roots()[0] || undefined });
          n.show(false);
          n.sendText(text, false);
        }
      });
      return false;
    }
    t.show(false);
    t.sendText(text, false);
    return true;
  };

  const context0 = (terminal, skipLast) => ({ shell: shellName(vscode, terminal), os: osName(), cwd: cwdOf(terminal, roots), root: roots()[0] || "", recent: recent.filter((r, i) => !(skipLast && i === recent.length - 1 && r.cmd === skipLast)) });

  // A risky command's warning sits in the status bar on the warning colour (a toast cut it off and stacked over later ones).
  let warnItem = null;
  const warn = (danger) => {
    if (warnItem) warnItem.dispose();
    warnItem = null;
    if (!danger) return;
    const text = `${danger} Not run yet.`;
    if (!vscode.window.createStatusBarItem) return void vscode.window.showWarningMessage(`✳ ${danger} Not run yet.`);
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment ? vscode.StatusBarAlignment.Left : 1, 1000);
    item.text = `$(warning) ${text}`;
    if (vscode.ThemeColor) item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    item.show();
    warnItem = item;
    setTimeout(() => {
      if (warnItem === item) warnItem = null;
      item.dispose();
    }, 20000);
  };

  const work = async (title, body) => {
    const go = async () => {
      try {
        return await askFriday(body);
      } catch (e) {
        vscode.window.showErrorMessage(`Could not ask: ${e && e.message ? e.message : e}`);
        return null;
      }
    };
    return vscode.window.withProgress ? vscode.window.withProgress({ location: vscode.ProgressLocation && vscode.ProgressLocation.Window, title }, go) : go();
  };

  const write = async () => {
    if (busy) return void vscode.window.showInformationMessage("Still writing the last command. One moment.");
    const terminal = vscode.window.activeTerminal;
    const request = await askInput(vscode, "✳ Write a command", "find the 10 biggest files here, or undo my last commit but keep the changes");
    if (!request) {
      if (terminal) terminal.show(false);
      return;
    }
    busy = true;
    try {
      const answer = await work("✳ Writing the command…", { mode: "write", request, ...context0(terminal) });
      if (!answer) return;
      if (!answer.command) return void vscode.window.showInformationMessage(answer.note || "No command came back. Try saying it another way.");
      if (!putIn(terminal, answer.command)) return;
      const line = answer.explain || "Press Enter to run it.";
      // A risky one says so in a warning of its own beside this (warn above); here it only gets the mark.
      vscode.window.setStatusBarMessage(`${answer.danger ? "⚠" : "✳"} ${line}`, 20000);
      warn(answer.danger);
    } finally {
      busy = false;
    }
  };

  /** A failed command: why, and the command that fixes it, in a quick pick (no notification). */
  const explain = async (f) => {
    // The failure whose button was pressed, else the last one (the palette's).
    const failure = f || last;
    if (!failure) return void vscode.window.showInformationMessage("No command has failed in the terminal yet.");
    if (!vscode.window.createQuickPick) return postAsk({ kind: "explain", path: "", from: 1, to: 1, text: "", root: failure.root, problem: failure.output || `exit ${failure.exit}`, source: `the terminal · ${failure.cmd}`, cwd: failure.cwd });
    const short = failure.cmd.length > 40 ? `${failure.cmd.slice(0, 39)}…` : failure.cmd;
    const pick = vscode.window.createQuickPick();
    pick.title = `✳ Why "${short}" failed`;
    pick.placeholder = "Esc to close";
    pick.matchOnDescription = false;
    pick.busy = true;
    pick.items = [{ label: "Reading the output…", alwaysShow: true }];
    let closed = false;
    pick.onDidHide(() => {
      closed = true;
      pick.dispose();
    });
    pick.onDidAccept(() => {
      const item = pick.selectedItems[0];
      if (!item || !item.run) return;
      pick.hide();
      item.run();
    });
    pick.show();
    const terminal = failure.terminal;
    const answer = await work("✳ Reading the failure…", { mode: "explain", failed: { cmd: failure.cmd, output: failure.output, exit: failure.exit }, ...context0(terminal, failure.cmd), cwd: failure.cwd || cwdOf(terminal, roots) });
    if (closed) return;
    pick.busy = false;
    if (!answer || (!answer.explain && !answer.command)) {
      pick.items = [{ label: (answer && answer.note) || "No answer came back.", alwaysShow: true }, ...more(failure)];
      return;
    }
    const sep = vscode.QuickPickItemKind ? vscode.QuickPickItemKind.Separator : -1;
    const items = wrap(answer.explain || "It failed, and there is no single command that fixes it.", 86).map((label) => ({ label, alwaysShow: true }));
    if (answer.danger) items.push({ label: `$(warning) ${answer.danger}`, alwaysShow: true });
    items.push({ label: "", kind: sep });
    if (answer.command) {
      items.push({ label: "$(terminal) Put it in the terminal", description: answer.command, alwaysShow: true, run: () => { if (!putIn(terminal, answer.command)) return; vscode.window.setStatusBarMessage("✳ Typed in, not run. Press Enter when you are ready.", 8000); warn(answer.danger); } });
    }
    items.push(...more(failure));
    pick.items = items;
    // The first row that does something is the one Enter takes.
    const first = items.find((i) => i.run);
    if (first) pick.activeItems = [first];
  };

  /** The longer ways: the same failure handed to Friday's column, to fix it or to be explained at length. */
  const more = (failure) => {
    const ask = (kind) => () => postAsk({ kind, path: "", from: 1, to: 1, text: "", root: failure.root, problem: failure.output || `exit ${failure.exit}`, source: `the terminal · ${failure.cmd}`, cwd: failure.cwd });
    return [
      { label: "$(sparkle) Fix it with Friday", description: "an agent reproduces it and fixes it", alwaysShow: true, run: ask("fix") },
      { label: "$(comment-discussion) Explain more in Friday", description: "in the agent column", alwaysShow: true, run: ask("explain") },
    ];
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("friday.terminal.write", write),
    vscode.commands.registerCommand("friday.terminal.explain", () => explain()),
  );

  return {
    /** The terminal watcher tells of every failure (extension.js), so the palette's Explain has the last one. */
    failed(f) {
      last = f;
    },
    explain,
    write,
  };
}

module.exports = { register, shellName, osName, cwdOf, oneLine, wrap };
