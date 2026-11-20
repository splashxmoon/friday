"use strict";
// Debug with the agent (Arun, 2026-11-19: "Debug with the agent: when you stop at a breakpoint or an exception, the agent sees the
// stack and the variables and tells you what's wrong, or fixes it."). A tracker watches every debug session for a stop; while one
// is stopped a status-bar item and an editor-title action offer "Ask Friday about this stop", and nothing pops up on its own. The ask
// carries the stack, the variables of the frame, the exception and the code at the line, kept under about 20 KB.
// "Friday: Debug this with an agent" is the same for when nothing is running yet: the person says what goes wrong and the agent
// reproduces it, using or adding a launch configuration.
// Plain CommonJS; the vscode API is passed in so a test can hand it a stand-in.
const fs = require("node:fs");
const path = require("node:path");

const MAX_FRAMES = 15;
const MAX_VARS = 60;
const MAX_VALUE = 200;
const MAX_NAME = 120;
const MAX_PROBLEM = 4000;
const MAX_CODE = 3000;
/** Everything one ask carries stays under this many characters of JSON. */
const MAX_TOTAL = 20000;
/** A debug adapter that does not answer must not hold the ask for long. */
const ASK_TIMEOUT = 4000;
/** And the whole reading of a stop (every request together) is held to this, so a slow adapter cannot keep a click silent for long. */
const GATHER_DEADLINE = 6000;
/** A variable named like a secret is sent without its value (the name still tells the agent it is there). */
const SECRET_NAME = /pass(word|wd)?|secret|token|credential|cookie|bearer|authori[sz]ation|api[_-]?key|private[_-]?key|access[_-]?key|(^|[^a-z])key($|[^a-z])/i;
/** The requests that let the program run on: a stop is over when one is sent, whether or not the adapter says "continued". */
const RESUMING = new Set(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue", "goto", "restartFrame", "restart", "disconnect", "terminate"]);

const clip = (v, n) => {
  const s = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** One line: an adapter prints a function's whole source as its value, and a frame can be named by one. */
const oneLine = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v);

/** A request to the debug adapter that gives up (to null) on an error or when it is slow: one missing piece does not stop the ask. */
async function request(session, command, args, ms = ASK_TIMEOUT) {
  if (ms <= 0) return null;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(session.customRequest(command, args)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A file path from the adapter as a plain one. Through the IDE's remote layer (code-server) a frame's path comes back as a URI
 * ("vscode-remote://127.0.0.1:5000/Users/me/app/a.js", "file:///c%3A/app/a.js"); a plain path (and a Windows "C:\\x") is left as it is.
 */
function plainPath(p) {
  if (typeof p !== "string" || !/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) return p || "";
  try {
    let f = decodeURIComponent(new URL(p).pathname);
    // "/c:/app/a.js" is "c:\\app\\a.js"'s URI form: the slash before the drive letter goes.
    if (/^\/[a-z]:\//i.test(f)) f = f.slice(1);
    // A drive path is spelled the Windows way ("c:\\app\\a.js"), so it compares with the folder's own spelling.
    return /^[a-z]:/i.test(f) ? path.win32.normalize(f) : f;
  } catch {
    return p;
  }
}

/**
 * A path the way the folder spells it. A debugger reports real paths (macOS: "/private/var/..." for a folder opened as "/var/..."),
 * and the page matches a file to the folder by its spelling, so the folder's own prefix is put back.
 */
function inFolderSpelling(roots, file, real = (p) => fs.realpathSync(p), pm = path) {
  if (!file || pm.isAbsolute(file) === false) return file;
  for (const r of roots) {
    if (isInside(r, file, pm)) return file;
    try {
      const rr = real(r);
      if (rr !== r && isInside(rr, file, pm)) return r + file.slice(rr.length);
    } catch {
      // A folder that can't be resolved is compared as it is spelled.
    }
  }
  return file;
}

/**
 * Whether `file` is `root` or inside it: whole folder names only ("/app2" is not in "/app"), either slash on Windows, and a drive
 * letter in either case ("C:" and "c:"). `pm` is the path module (path.win32 in a test).
 */
function isInside(root, file, pm = path) {
  if (!root || !file) return false;
  const win = pm === path.win32 || /^[a-z]:/i.test(root);
  const norm = (p) => {
    let n = (win ? path.win32 : pm).normalize(p);
    if (win) n = n.toLowerCase();
    return n.length > 1 ? n.replace(/[\\/]+$/, "") : n;
  };
  const r = norm(root);
  const f = norm(file);
  const sep = win ? "\\" : pm.sep;
  return f === r || f.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** A path as the agent should read it: from the folder when it is inside it, else whole. */
function relativeTo(root, file) {
  if (!root || !file) return file || "";
  const pm = /^[a-z]:/i.test(root) ? path.win32 : path;
  const rel = pm.relative(root, file);
  return (rel && !rel.startsWith("..") && !pm.isAbsolute(rel) ? rel : file).split(pm.sep).join("/");
}

/** A frame the person wrote, not the runtime's own ("<node_internals>/...", "node:internal/...", a frame with no file). */
const isUserFrame = (f) => !!(f && f.source && f.source.path && !/^<|^node:|^internal\//.test(f.source.path) && !(f.source.presentationHint === "deemphasize"));

/** The lines around `line` (1-based) of a file, with their numbers, or "" when the file cannot be read. */
function codeAround(file, line, readFile = (p) => fs.readFileSync(p, "utf8")) {
  try {
    const lines = String(readFile(file)).split(/\r?\n/);
    const from = Math.max(1, line - 10);
    const to = Math.min(lines.length, line + 6);
    const out = [];
    for (let i = from; i <= to; i++) out.push(`${i === line ? ">" : " "}${String(i).padStart(4)}  ${lines[i - 1]}`);
    return out.join("\n").slice(0, MAX_CODE);
  } catch {
    return "";
  }
}

/**
 * What a stop says, read from the session: the exception (when it stopped on one), the top frames, and the variables of the first
 * frame in the person's own code. Depth one (a value is shown as the adapter prints it, an object is not opened), at most 60
 * variables, each value at most 200 characters. `stop` is {reason, threadId, description, text} from the adapter's stopped event.
 */
async function gather(session, stop, roots = [], readFile, real, deadline = GATHER_DEADLINE) {
  const end = Date.now() + deadline;
  const rq = (command, args) => request(session, command, args, Math.min(ASK_TIMEOUT, end - Date.now()));
  const reason = clip((stop && stop.reason) || "", 40);
  let threadId = stop && Number.isFinite(stop.threadId) ? stop.threadId : undefined;
  if (threadId === undefined) {
    const t = await rq("threads");
    const first = t && Array.isArray(t.threads) ? t.threads[0] : null;
    threadId = first ? first.id : 1;
  }
  const trace = await rq("stackTrace", { threadId, startFrame: 0, levels: MAX_FRAMES });
  const frames = trace && Array.isArray(trace.stackFrames) ? trace.stackFrames.slice(0, MAX_FRAMES) : [];
  for (const f of frames) if (f.source && f.source.path) f.source = { ...f.source, path: inFolderSpelling(roots, plainPath(f.source.path), real) };
  // The frame the person picked in Call Stack (when they did), else the first of their own code.
  const picked = stop && stop.frameId !== undefined ? frames.find((f) => f.id === stop.frameId) : null;
  const own = picked || frames.find(isUserFrame) || frames[0];
  const rootOf = (file) => roots.find((r) => isInside(r, file)) || roots[0] || "";
  const stack = frames.map((f) => {
    const file = (f.source && (f.source.path || f.source.name)) || "";
    return { name: clip(oneLine(f.name), MAX_NAME), path: relativeTo(rootOf(file), file), line: Number(f.line) || 0 };
  });

  // The exception: its type, its message and where the runtime says it came from.
  let problem = "";
  if (reason === "exception" || (stop && /exception|error/i.test((stop.description || "") + (stop.text || "")))) {
    const info = await rq("exceptionInfo", { threadId });
    if (info) {
      const d = info.details || {};
      const head = [d.typeName || info.exceptionId, d.message || info.description].filter(Boolean).join(": ");
      problem = [head, d.stackTrace].filter(Boolean).join("\n");
    }
  }
  if (!problem && stop && reason === "exception") problem = [stop.description, stop.text].filter(Boolean).join(" — ");
  problem = clip(problem, MAX_PROBLEM);

  // The variables of that frame, scope by scope, skipping the scopes an adapter marks expensive (the whole global object).
  const vars = [];
  if (own && own.id !== undefined) {
    const sc = await rq("scopes", { frameId: own.id });
    for (const scope of (sc && Array.isArray(sc.scopes) ? sc.scopes : []).filter((s) => !s.expensive)) {
      if (vars.length >= MAX_VARS) break;
      const v = await rq("variables", { variablesReference: scope.variablesReference });
      for (const x of v && Array.isArray(v.variables) ? v.variables : []) {
        if (vars.length >= MAX_VARS) break;
        vars.push({ name: clip(x.name, MAX_NAME), value: SECRET_NAME.test(String(x.name)) ? "‹hidden›" : clip(oneLine(x.value), MAX_VALUE), ...(x.type ? { type: clip(x.type, 60) } : {}), scope: clip(scope.name, 40) });
      }
    }
  }

  const file = own && own.source && own.source.path ? own.source.path : "";
  const line = own ? Number(own.line) || 1 : 1;
  const root = rootOf(file);
  return { reason, thread: threadId, file, line, root, problem, stack, vars, code: file ? codeAround(file, line, readFile) : "" };
}

/** The ask to post for a gathered stop, held to MAX_TOTAL: variables go first, then the deepest frames, then the text. */
function stopAsk(g, sessionName) {
  const ask = {
    kind: "debug",
    path: g.file || "",
    from: Math.max(1, g.line - 10),
    to: g.line + 6,
    line: g.line,
    text: g.code || "",
    root: g.root || "",
    problem: g.problem || "",
    source: sessionName ? `the debugger · ${sessionName}` : "the debugger",
    reason: g.reason || "",
    stack: g.stack.slice(),
    vars: g.vars.slice(),
  };
  const size = () => JSON.stringify(ask).length;
  while (size() > MAX_TOTAL && ask.vars.length) ask.vars.pop();
  while (size() > MAX_TOTAL && ask.stack.length > 5) ask.stack.pop();
  if (size() > MAX_TOTAL) ask.text = ask.text.slice(0, 800);
  if (size() > MAX_TOTAL) ask.problem = ask.problem.slice(0, 1500);
  return ask;
}

/** The ask for "Debug this with an agent" when nothing is stopped: what the person says goes wrong, and the code they were in. */
function describeAsk(text, doc, selection, root) {
  const ask = { kind: "debug", path: "", from: 1, to: 1, text: "", root: root || "", problem: clip(String(text).trim(), MAX_PROBLEM), source: "you", reproduce: true, stack: [], vars: [] };
  if (doc && doc.uri && doc.uri.fsPath) {
    ask.path = doc.uri.fsPath;
    const range = selection && !selection.isEmpty ? selection : null;
    ask.from = range ? range.start.line + 1 : 1;
    ask.to = range ? range.end.line + 1 : 1;
    ask.text = range ? clip(doc.getText(range), MAX_CODE) : "";
  }
  return ask;
}

function register(vscode, context, postAsk, rootsOf) {
  if (!vscode.debug || !vscode.debug.registerDebugAdapterTrackerFactory) return;
  // session id -> { session, body }, while that session is stopped. The session object is kept: with two sessions (a compound
  // launch, js-debug's parent and child) the stopped one is not always the focused one.
  const stops = new Map();
  let item = null;
  let busy = false;

  const show = () => {
    const on = stops.size > 0;
    if (vscode.commands && vscode.commands.executeCommand) void Promise.resolve(vscode.commands.executeCommand("setContext", "friday.debugStopped", on)).catch(() => {});
    if (!vscode.window || !vscode.window.createStatusBarItem) return;
    if (on && !item) {
      item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment ? vscode.StatusBarAlignment.Left : 1, 90);
      item.text = "✳ Ask Friday about this stop";
      item.tooltip = "Friday's agent reads the stack and the variables of this frame (their values are sent) and says what is wrong";
      item.command = "friday.debugAsk";
      context.subscriptions.push(item);
    }
    if (item) on ? item.show() : item.hide();
  };
  const clear = (id) => {
    if (stops.delete(id)) show();
  };

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage(m) {
            if (!m || m.type !== "event") return;
            if (m.event === "stopped") {
              // Newest last, so "the most recently stopped" is the last key.
              stops.delete(session.id);
              stops.set(session.id, { session, body: m.body || {} });
              show();
            } else if (m.event === "continued") {
              // One thread running on while the others stay paused is still a stop.
              const cur = stops.get(session.id);
              const b = m.body || {};
              if (cur && b.allThreadsContinued === false && cur.body.threadId !== undefined && b.threadId !== cur.body.threadId) return;
              clear(session.id);
            } else if (m.event === "terminated" || m.event === "exited") {
              clear(session.id);
            }
          },
          // An adapter need not say "continued" after it was asked to continue or step (dlv does not), so the request ends the stop.
          onWillReceiveMessage(m) {
            if (m && m.type === "request" && RESUMING.has(m.command)) clear(session.id);
          },
          onWillStopSession() {
            clear(session.id);
          },
          onExit() {
            clear(session.id);
          },
        };
      },
    }),
  );
  if (vscode.debug.onDidTerminateDebugSession) context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((s) => clear(s.id)));

  const askAboutStop = async () => {
    // A double click is one ask.
    if (busy) return;
    busy = true;
    try {
      // The focused session when it is the stopped one, else the one that stopped last.
      const active = vscode.debug.activeDebugSession;
      const cur = (active && stops.get(active.id)) || [...stops.values()].pop();
      if (!cur) {
        vscode.window.showInformationMessage("Nothing is stopped in the debugger right now.");
        return;
      }
      // The thread and frame the person picked in Call Stack, when they are of this session.
      const stop = { ...cur.body };
      const pick = vscode.debug.activeStackItem;
      if (pick && pick.session && pick.session.id === cur.session.id && pick.threadId !== undefined) {
        stop.threadId = pick.threadId;
        if (pick.frameId !== undefined) stop.frameId = pick.frameId;
      }
      const read = () => gather(cur.session, stop, rootsOf());
      const g = await (vscode.window.withProgress ? vscode.window.withProgress({ location: vscode.ProgressLocation ? vscode.ProgressLocation.Window : 10, title: "Friday: reading the stop…" }, read) : read());
      if (!g.stack.length && !g.problem) {
        vscode.window.showInformationMessage("Couldn't read the stop from the debugger. Try again, or step once first.");
        return;
      }
      if (await postAsk(stopAsk(g, cur.session.name))) vscode.window.setStatusBarMessage("Sent to Friday's agent panel", 2500);
    } finally {
      busy = false;
    }
  };

  const debugWithAgent = async () => {
    // Stopped already: the stop says more than words would.
    if (stops.size) return askAboutStop();
    const editor = vscode.window.activeTextEditor;
    const text = await vscode.window.showInputBox({
      title: "Debug this with an agent",
      prompt: "What goes wrong? Say what you run and what you expected.",
      placeHolder: "npm test fails on the refund test, expected 500 got 0",
      ignoreFocusOut: true,
    });
    if (!text || !text.trim()) return;
    const roots = rootsOf();
    const file = editor && editor.document ? editor.document.uri.fsPath : "";
    const root = roots.find((r) => isInside(r, file)) || roots[0] || "";
    if (await postAsk(describeAsk(text.trim(), editor && editor.document, editor && editor.selection, root))) vscode.window.setStatusBarMessage("Sent to Friday's agent panel", 2500);
  };

  context.subscriptions.push(vscode.commands.registerCommand("friday.debugAsk", askAboutStop), vscode.commands.registerCommand("friday.debugWithAgent", debugWithAgent));
  return { stops, askAboutStop, debugWithAgent };
}

module.exports = { register, gather, plainPath, inFolderSpelling, isInside, relativeTo, stopAsk, describeAsk, codeAround, isUserFrame, MAX_FRAMES, MAX_VARS, MAX_VALUE, MAX_TOTAL };
